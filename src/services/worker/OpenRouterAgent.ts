/**
 * OpenRouterAgent: OpenRouter-based observation extraction
 *
 * Alternative to SDKAgent that uses OpenRouter's unified API
 * for accessing 100+ models from different providers.
 *
 * Responsibility:
 * - Call OpenRouter REST API for observation extraction
 * - Parse XML responses (same format as Claude/Gemini)
 * - Sync to database and Chroma
 * - Support dynamic model selection across providers
 */

import { buildContinuationPrompt, buildInitPrompt, buildObservationPrompt, buildSummaryPrompt } from '../../sdk/prompts.js';
import { getCredential } from '../../shared/EnvManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import {
  isAbortError,
  processAgentResponse,
  type FallbackAgent,
  type WorkerRef
} from './agents/index.js';
import { isGeminiAvailable } from './GeminiAgent.js';

// Context window management constants (defaults, overridable via settings)
const DEFAULT_MAX_CONTEXT_MESSAGES = 20;  // Maximum messages to keep in conversation history
const DEFAULT_MAX_ESTIMATED_TOKENS = 100000;  // ~100k tokens max context (safety limit)
const CHARS_PER_TOKEN_ESTIMATE = 4;  // Conservative estimate: 1 token = 4 chars

// OpenAI-compatible message format
interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
    code?: string;
  };
}

export class OpenRouterAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private geminiAgent: FallbackAgent | null = null;
  private fallbackAgent: FallbackAgent | null = null;

  // Cooldown tracking: when proxy reports model_cooldown with reset_seconds,
  // skip OpenRouter entirely and route to Gemini until cooldown expires
  private static cooldownUntil: number = 0;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Check if OpenRouter is currently in cooldown
   */
  static isInCooldown(): boolean {
    return Date.now() < OpenRouterAgent.cooldownUntil;
  }

  /**
   * Get remaining cooldown seconds (0 if not in cooldown)
   */
  static getCooldownRemainingSeconds(): number {
    return Math.max(0, Math.ceil((OpenRouterAgent.cooldownUntil - Date.now()) / 1000));
  }

  /**
   * Set the Gemini agent for secondary fallback
   * Must be set after construction to avoid circular dependency
   */
  setGeminiAgent(agent: FallbackAgent): void {
    this.geminiAgent = agent;
  }

  /**
   * Set the fallback agent (Claude SDK) for when all other providers fail
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start OpenRouter agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    // Check if OpenRouter is in cooldown - delegate to Gemini directly
    if (OpenRouterAgent.isInCooldown()) {
      const remaining = OpenRouterAgent.getCooldownRemainingSeconds();
      logger.info('SDK', `OpenRouter in cooldown (${remaining}s remaining), delegating to Gemini`, {
        sessionDbId: session.sessionDbId,
        cooldownUntil: new Date(OpenRouterAgent.cooldownUntil).toISOString()
      });

      if (isGeminiAvailable() && this.geminiAgent) {
        return this.geminiAgent.startSession(session, worker);
      }
      logger.warn('SDK', 'OpenRouter in cooldown but Gemini not available, attempting anyway');
    }

    try {
      // Get OpenRouter configuration
      const { apiKey, models, baseUrl, siteUrl, appName } = this.getOpenRouterConfig();

      if (!apiKey) {
        throw new Error('OpenRouter API key not configured. Set CLAUDE_MEM_OPENROUTER_API_KEY in settings or OPENROUTER_API_KEY environment variable.');
      }

      // Generate synthetic memorySessionId (OpenRouter is stateless, doesn't return session IDs)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `openrouter-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=OpenRouter`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query OpenRouter with full context (with automatic fallback)
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryOpenRouterWithFallback(session.conversationHistory, apiKey, models, baseUrl, siteUrl, appName);

      if (initResponse.content) {
        // Add response to conversation history
        // session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

        // Track token usage
        const tokensUsed = initResponse.tokensUsed || 0;
        session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);  // Rough estimate
        session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);

        // Process response using shared ResponseProcessor (no original timestamp for init - not from queue)
        await processAgentResponse(
          initResponse.content,
          session,
          this.dbManager,
          this.sessionManager,
          worker,
          tokensUsed,
          null,
          'OpenRouter',
          undefined  // No lastCwd yet - before message processing
        );
      } else {
        logger.error('SDK', 'Empty OpenRouter init response - session may lack context', {
          sessionId: session.sessionDbId,
          models: models.join(', ')
        });
      }

      // Track lastCwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      // Process pending messages
      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
        // The message is now in 'processing' status in DB until ResponseProcessor calls confirmProcessed()
        session.processingMessageIds.push(message._persistentId);

        // Capture cwd from messages for proper worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        const originalTimestamp = session.earliestPendingTimestamp;

        if (message.type === 'observation') {
          // Update last prompt number
          if (message.prompt_number !== undefined) {
            session.lastPromptNumber = message.prompt_number;
          }

          // CRITICAL: Check memorySessionId BEFORE making expensive LLM call
          // This prevents wasting tokens when we won't be able to store the result anyway
          if (!session.memorySessionId) {
            throw new Error('Cannot process observations: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          // Build observation prompt
          const obsPrompt = buildObservationPrompt({
            id: 0,
            tool_name: message.tool_name!,
            tool_input: JSON.stringify(message.tool_input),
            tool_output: JSON.stringify(message.tool_response),
            created_at_epoch: originalTimestamp ?? Date.now(),
            cwd: message.cwd
          });

          // Add to conversation history and query OpenRouter with full context (with automatic fallback)
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryOpenRouterWithFallback(session.conversationHistory, apiKey, models, baseUrl, siteUrl, appName);

          let tokensUsed = 0;
          if (obsResponse.content) {
            // Add response to conversation history
            // session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            obsResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenRouter',
            lastCwd
          );

        } else if (message.type === 'summarize') {
          // CRITICAL: Check memorySessionId BEFORE making expensive LLM call
          if (!session.memorySessionId) {
            throw new Error('Cannot process summary: memorySessionId not yet captured. This session may need to be reinitialized.');
          }

          // Build summary prompt
          const summaryPrompt = buildSummaryPrompt({
            id: session.sessionDbId,
            memory_session_id: session.memorySessionId,
            project: session.project,
            user_prompt: session.userPrompt,
            last_assistant_message: message.last_assistant_message || ''
          }, mode);

          // Add to conversation history and query OpenRouter with full context (with automatic fallback)
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryOpenRouterWithFallback(session.conversationHistory, apiKey, models, baseUrl, siteUrl, appName);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            // Add response to conversation history
            // session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          await processAgentResponse(
            summaryResponse.content || '',
            session,
            this.dbManager,
            this.sessionManager,
            worker,
            tokensUsed,
            originalTimestamp,
            'OpenRouter',
            lastCwd
          );
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'OpenRouter agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length,
        models: models.join(', ')
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'OpenRouter agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Fallback: use wired fallback agent (avoids circular loops when
      // this agent is itself a fallback target from the primary provider).
      if (this.fallbackAgent && !session.inFallback) {
        logger.warn('SDK', 'OpenRouter failed, falling back to next agent', {
          sessionDbId: session.sessionDbId,
          error: errorMessage,
        });
        // Reset history — fallback agent manages its own context
        session.conversationHistory = [];
        session.inFallback = true;
        try {
          return await this.fallbackAgent.startSession(session, worker);
        } catch (fallbackError: unknown) {
          logger.failure('SDK', 'OpenRouter and fallback agent both failed', {
            sessionDbId: session.sessionDbId,
            openRouterError: errorMessage,
            fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          }, fallbackError as Error);
          // Only set quotaPaused if the root cause was actually quota-related.
          // Non-quota fallback failures (e.g., auth errors) should propagate
          // normally so the restart handler can apply its own retry logic.
          const fbMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          const isQuota = fbMsg.includes('429') || fbMsg.includes('quota') || fbMsg.includes('RESOURCE_EXHAUSTED');
          if (isQuota || errorMessage.includes('429') || errorMessage.includes('cooldown')) {
            session.quotaPaused = true;
            return;
          }
          throw fallbackError;
        } finally {
          session.inFallback = false;
        }
      }

      logger.failure('SDK', 'OpenRouter agent error (no fallback available)', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Estimate token count from text (conservative estimate)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
  }

  /**
   * Truncate conversation history to prevent runaway context costs
   * Keeps most recent messages within token budget
   */
  private truncateHistory(history: ConversationMessage[]): ConversationMessage[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    const MAX_CONTEXT_MESSAGES = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES) || DEFAULT_MAX_CONTEXT_MESSAGES;
    const MAX_ESTIMATED_TOKENS = parseInt(settings.CLAUDE_MEM_OPENROUTER_MAX_TOKENS) || DEFAULT_MAX_ESTIMATED_TOKENS;

    if (history.length <= MAX_CONTEXT_MESSAGES) {
      // Check token count even if message count is ok
      const totalTokens = history.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (totalTokens <= MAX_ESTIMATED_TOKENS) {
        return history;
      }
    }

    // Sliding window: keep most recent messages within limits
    const truncated: ConversationMessage[] = [];
    let tokenCount = 0;

    // Process messages in reverse (most recent first)
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const msgTokens = this.estimateTokens(msg.content);

      if (truncated.length >= MAX_CONTEXT_MESSAGES || tokenCount + msgTokens > MAX_ESTIMATED_TOKENS) {
        logger.warn('SDK', 'Context window truncated to prevent runaway costs', {
          originalMessages: history.length,
          keptMessages: truncated.length,
          droppedMessages: i + 1,
          estimatedTokens: tokenCount,
          tokenLimit: MAX_ESTIMATED_TOKENS
        });
        break;
      }

      truncated.unshift(msg);  // Add to beginning
      tokenCount += msgTokens;
    }

    return truncated;
  }

  /**
   * Convert shared ConversationMessage array to OpenAI-compatible message format
   */
  private conversationToOpenAIMessages(history: ConversationMessage[]): OpenAIMessage[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));
  }

  /**
   * Query OpenRouter with automatic fallback to next model on quota/rate limit errors
   * Tries models in order until one succeeds or all fail
   */
  private async queryOpenRouterWithFallback(
    history: ConversationMessage[],
    apiKey: string,
    models: string[],
    baseUrl: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    const errors: Array<{ model: string; error: string }> = [];

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      try {
        logger.debug('SDK', `Trying OpenRouter model ${i + 1}/${models.length}: ${model}`);

        const result = await this.queryOpenRouterMultiTurn(
          history,
          apiKey,
          model,
          baseUrl,
          siteUrl,
          appName
        );

        // Success - log if we had to fall back
        if (i > 0) {
          logger.success('SDK', `OpenRouter fallback successful`, {
            failedModels: errors.map(e => e.model).join(', '),
            successModel: model,
            attemptNumber: i + 1
          });
        }

        return result;

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({ model, error: errorMessage });

        // Check if this is a quota/rate limit error that should trigger fallback
        const isQuotaError = errorMessage.toLowerCase().includes('quota') ||
                            errorMessage.toLowerCase().includes('rate limit') ||
                            errorMessage.toLowerCase().includes('insufficient') ||
                            errorMessage.toLowerCase().includes('credit') ||
                            errorMessage.toLowerCase().includes('429');

        // If cooldown was set (with reset_seconds), skip remaining models -
        // they share the same proxy/credentials and will also be in cooldown
        if (OpenRouterAgent.isInCooldown()) {
          logger.warn('SDK', 'OpenRouter cooldown active, skipping remaining models', {
            failedModel: model,
            remainingSeconds: OpenRouterAgent.getCooldownRemainingSeconds()
          });
          throw new Error(`OpenRouter in cooldown (${OpenRouterAgent.getCooldownRemainingSeconds()}s remaining). Last error: ${errorMessage}`);
        }

        if (isQuotaError && i < models.length - 1) {
          // Quota error and we have more models to try
          logger.warn('SDK', `OpenRouter model quota exhausted, falling back to next model`, {
            failedModel: model,
            nextModel: models[i + 1],
            error: errorMessage
          });
          continue;
        }

        // Last model or non-quota error - throw
        if (i === models.length - 1) {
          // All models failed
          logger.error('SDK', 'All OpenRouter models failed', {
            attemptedModels: models.join(', '),
            errors: errors.map(e => `${e.model}: ${e.error}`).join(' | ')
          });
          throw new Error(`All OpenRouter models failed. Last error: ${errorMessage}`);
        }

        // Non-quota error - throw immediately
        throw error;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('OpenRouter fallback logic error: exhausted all models without result');
  }

  /**
   * Query OpenRouter via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryOpenRouterMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: string,
    baseUrl: string,
    siteUrl?: string,
    appName?: string
  ): Promise<{ content: string; tokensUsed?: number }> {
    // Truncate history to prevent runaway costs
    const truncatedHistory = this.truncateHistory(history);
    const messages = this.conversationToOpenAIMessages(truncatedHistory);
    const totalChars = truncatedHistory.reduce((sum, m) => sum + m.content.length, 0);
    const estimatedTokens = this.estimateTokens(truncatedHistory.map(m => m.content).join(''));

    logger.debug('SDK', `Querying OpenRouter multi-turn (${model})`, {
      turns: truncatedHistory.length,
      totalChars,
      estimatedTokens
    });

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': siteUrl || 'https://github.com/thedotmack/claude-mem',
        'X-Title': appName || 'claude-mem',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,  // Lower temperature for structured extraction
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Parse cooldown info from 429 responses to enable proactive routing
      if (response.status === 429) {
        try {
          const errorData = JSON.parse(errorText);
          const resetSeconds = errorData.error?.reset_seconds;
          if (resetSeconds && typeof resetSeconds === 'number') {
            OpenRouterAgent.cooldownUntil = Date.now() + (resetSeconds * 1000);
            logger.warn('SDK', `OpenRouter cooldown detected, switching to fallback for ${resetSeconds}s`, {
              model,
              resetSeconds,
              resetTime: errorData.error.reset_time,
              cooldownUntil: new Date(OpenRouterAgent.cooldownUntil).toISOString()
            });
          }
        } catch { /* response may not be JSON - fall through to normal error handling */ }
      }

      throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OpenRouterResponse;

    // Check for API error in response body
    if (data.error) {
      throw new Error(`OpenRouter API error: ${data.error.code} - ${data.error.message}`);
    }

    if (!data.choices?.[0]?.message?.content) {
      logger.error('SDK', 'Empty response from OpenRouter');
      return { content: '' };
    }

    const content = data.choices[0].message.content;
    const tokensUsed = data.usage?.total_tokens;

    // Log actual token usage for cost tracking
    if (tokensUsed) {
      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;
      // Token usage (cost varies by model - many OpenRouter models are free)
      const estimatedCost = (inputTokens / 1000000 * 3) + (outputTokens / 1000000 * 15);

      logger.info('SDK', 'OpenRouter API usage', {
        model,
        inputTokens,
        outputTokens,
        totalTokens: tokensUsed,
        estimatedCostUSD: estimatedCost.toFixed(4),
        messagesInContext: truncatedHistory.length
      });

      // Warn if costs are getting high
      if (tokensUsed > 50000) {
        logger.warn('SDK', 'High token usage detected - consider reducing context', {
          totalTokens: tokensUsed,
          estimatedCost: estimatedCost.toFixed(4)
        });
      }
    }

    return { content, tokensUsed };
  }

  /**
   * Get OpenRouter configuration from settings or environment
   * Supports multiple models separated by comma for automatic fallback
   * Issue #733: Uses centralized ~/.claude-mem/.env for credentials, not random project .env files
   */
  private getOpenRouterConfig(): { apiKey: string; models: string[]; baseUrl: string; siteUrl?: string; appName?: string } {
    const settingsPath = USER_SETTINGS_PATH;
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then centralized claude-mem .env (NOT process.env)
    // This prevents Issue #733 where random project .env files could interfere
    const apiKey = settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY') || '';

    // Models: parse comma-separated list from settings or use default
    const modelString = settings.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free';
    let models = modelString.split(',').map(m => m.trim()).filter(m => m.length > 0);

    // If no valid models configured, use default
    if (models.length === 0) {
      models = ['gemini-3-flash-preview'];
      logger.warn('SDK', 'No OpenRouter models configured, using default: gemini-3-flash-preview');
    }

    // Base URL: from settings or default
    const baseUrl = settings.CLAUDE_MEM_OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1/chat/completions';

    // Optional analytics headers
    const siteUrl = settings.CLAUDE_MEM_OPENROUTER_SITE_URL || '';
    const appName = settings.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem';

    return { apiKey, models, baseUrl, siteUrl, appName };
  }
}

/**
 * Check if OpenRouter is available (has API key configured)
 * Issue #733: Uses centralized ~/.claude-mem/.env, not random project .env files
 */
export function isOpenRouterAvailable(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_OPENROUTER_API_KEY || getCredential('OPENROUTER_API_KEY'));
}

/**
 * Check if OpenRouter is the selected provider
 */
export function isOpenRouterSelected(): boolean {
  const settingsPath = USER_SETTINGS_PATH;
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'openrouter';
}
