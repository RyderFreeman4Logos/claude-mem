/**
 * GeminiAgent: Gemini-based observation extraction
 *
 * Alternative to SDKAgent that uses Google's Gemini API directly
 * for extracting observations from tool usage.
 *
 * Responsibility:
 * - Call Gemini REST API for observation extraction
 * - Parse XML responses (same format as Claude)
 * - Sync to database and Chroma
 */

import path from 'path';
import { homedir } from 'os';
import { DatabaseManager } from './DatabaseManager.js';
import { SessionManager } from './SessionManager.js';
import { logger } from '../../utils/logger.js';
import { buildInitPrompt, buildObservationPrompt, buildSummaryPrompt, buildContinuationPrompt } from '../../sdk/prompts.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { getCredential } from '../../shared/EnvManager.js';
import type { ActiveSession, ConversationMessage } from '../worker-types.js';
import { ModeManager } from '../domain/ModeManager.js';
import {
  processAgentResponse,
  isAbortError,
  type WorkerRef,
  type FallbackAgent
} from './agents/index.js';

// Gemini API endpoint — use v1beta for preview models.
// gemini-3-flash-preview is only available on v1beta, not v1.
// v1beta also supports non-preview models like gemini-3-flash.
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Gemini model types (available via API)
// NOTE: Gemini 2.x models removed intentionally — gemini-3-flash-preview
// outperforms 2.5-flash on all benchmarks (GPQA 90.4% vs ~65%, SWE-bench 78% vs ~40%)
// while using 30% fewer tokens. Keeping deprecated models risks silent quality regression
// when upstream merges re-add them. If you need 2.x for testing, add it back explicitly.
export type GeminiModel =
  | 'gemini-3-flash'
  | 'gemini-3-flash-preview';

// Free tier RPM limits by model (requests per minute)
const GEMINI_RPM_LIMITS: Record<GeminiModel, number> = {
  'gemini-3-flash': 10,
  'gemini-3-flash-preview': 5,
};

// Track last request time for rate limiting
let lastRequestTime = 0;

/**
 * Enforce RPM rate limit for Gemini free tier.
 * Waits the required time between requests based on model's RPM limit + 100ms safety buffer.
 * Skipped entirely if rate limiting is disabled (billing users with 1000+ RPM available).
 */
async function enforceRateLimitForModel(model: GeminiModel, rateLimitingEnabled: boolean): Promise<void> {
  // Skip rate limiting if disabled (billing users with 1000+ RPM)
  if (!rateLimitingEnabled) {
    return;
  }

  const rpm = GEMINI_RPM_LIMITS[model] || 5;
  const minimumDelayMs = Math.ceil(60000 / rpm) + 100; // (60s / RPM) + 100ms safety buffer

  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < minimumDelayMs) {
    const waitTime = minimumDelayMs - timeSinceLastRequest;
    logger.debug('SDK', `Rate limiting: waiting ${waitTime}ms before Gemini request`, { model, rpm });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  lastRequestTime = Date.now();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/**
 * Gemini content message format
 * role: "user" or "model" (Gemini uses "model" not "assistant")
 */
interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

export class GeminiAgent {
  private dbManager: DatabaseManager;
  private sessionManager: SessionManager;
  private fallbackAgent: FallbackAgent | null = null;

  constructor(dbManager: DatabaseManager, sessionManager: SessionManager) {
    this.dbManager = dbManager;
    this.sessionManager = sessionManager;
  }

  /**
   * Set the fallback agent (Claude SDK) for when Gemini API fails
   * Must be set after construction to avoid circular dependency
   */
  setFallbackAgent(agent: FallbackAgent): void {
    this.fallbackAgent = agent;
  }

  /**
   * Start Gemini agent for a session
   * Uses multi-turn conversation to maintain context across messages
   */
  async startSession(session: ActiveSession, worker?: WorkerRef): Promise<void> {
    try {
      // Get Gemini configuration
      const { apiKey, model, rateLimitingEnabled } = this.getGeminiConfig();

      if (!apiKey) {
        throw new Error('Gemini API key not configured. Set CLAUDE_MEM_GEMINI_API_KEY in settings or GEMINI_API_KEY environment variable.');
      }

      // Generate synthetic memorySessionId (Gemini is stateless, doesn't return session IDs)
      if (!session.memorySessionId) {
        const syntheticMemorySessionId = `gemini-${session.contentSessionId}-${Date.now()}`;
        session.memorySessionId = syntheticMemorySessionId;
        this.dbManager.getSessionStore().updateMemorySessionId(session.sessionDbId, syntheticMemorySessionId);
        logger.info('SESSION', `MEMORY_ID_GENERATED | sessionDbId=${session.sessionDbId} | provider=Gemini`);
      }

      // Load active mode
      const mode = ModeManager.getInstance().getActiveMode();

      // Build initial prompt
      const initPrompt = session.lastPromptNumber === 1
        ? buildInitPrompt(session.project, session.contentSessionId, session.userPrompt, mode)
        : buildContinuationPrompt(session.userPrompt, session.lastPromptNumber, session.contentSessionId, mode);

      // Add to conversation history and query Gemini with full context
      session.conversationHistory.push({ role: 'user', content: initPrompt });
      const initResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

      if (initResponse.content) {
        // Add response to conversation history
        session.conversationHistory.push({ role: 'assistant', content: initResponse.content });

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
          'Gemini'
        );
      } else {
        logger.error('SDK', 'Empty Gemini init response - session may lack context', {
          sessionId: session.sessionDbId,
          model
        });
      }

      // Process pending messages
      // Track cwd from messages for CLAUDE.md generation
      let lastCwd: string | undefined;

      for await (const message of this.sessionManager.getMessageIterator(session.sessionDbId)) {
        // CLAIM-CONFIRM: Track message ID for confirmProcessed() after successful storage
        // The message is now in 'processing' status in DB until ResponseProcessor calls confirmProcessed()
        session.processingMessageIds.push(message._persistentId);

        // Capture cwd from each message for worktree support
        if (message.cwd) {
          lastCwd = message.cwd;
        }
        // Capture earliest timestamp BEFORE processing (will be cleared after)
        // This ensures backlog messages get their original timestamps, not current time
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

          // Add to conversation history and query Gemini with full context
          session.conversationHistory.push({ role: 'user', content: obsPrompt });
          const obsResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

          let tokensUsed = 0;
          if (obsResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: obsResponse.content });

            tokensUsed = obsResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          if (obsResponse.content) {
            await processAgentResponse(
              obsResponse.content,
              session,
              this.dbManager,
              this.sessionManager,
              worker,
              tokensUsed,
              originalTimestamp,
              'Gemini',
              lastCwd
            );
          } else {
            logger.warn('SDK', 'Empty Gemini observation response, skipping processing to preserve message', {
              sessionId: session.sessionDbId,
              messageId: session.processingMessageIds[session.processingMessageIds.length - 1]
            });
            // Don't confirm - leave message for stale recovery
          }

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

          // Add to conversation history and query Gemini with full context
          session.conversationHistory.push({ role: 'user', content: summaryPrompt });
          const summaryResponse = await this.queryGeminiMultiTurn(session.conversationHistory, apiKey, model, rateLimitingEnabled);

          let tokensUsed = 0;
          if (summaryResponse.content) {
            // Add response to conversation history
            session.conversationHistory.push({ role: 'assistant', content: summaryResponse.content });

            tokensUsed = summaryResponse.tokensUsed || 0;
            session.cumulativeInputTokens += Math.floor(tokensUsed * 0.7);
            session.cumulativeOutputTokens += Math.floor(tokensUsed * 0.3);
          }

          // Process response using shared ResponseProcessor
          if (summaryResponse.content) {
            await processAgentResponse(
              summaryResponse.content,
              session,
              this.dbManager,
              this.sessionManager,
              worker,
              tokensUsed,
              originalTimestamp,
              'Gemini',
              lastCwd
            );
          } else {
            logger.warn('SDK', 'Empty Gemini summary response, skipping processing to preserve message', {
              sessionId: session.sessionDbId,
              messageId: session.processingMessageIds[session.processingMessageIds.length - 1]
            });
            // Don't confirm - leave message for stale recovery
          }
        }
      }

      // Mark session complete
      const sessionDuration = Date.now() - session.startTime;
      logger.success('SDK', 'Gemini agent completed', {
        sessionId: session.sessionDbId,
        duration: `${(sessionDuration / 1000).toFixed(1)}s`,
        historyLength: session.conversationHistory.length
      });

    } catch (error: unknown) {
      if (isAbortError(error)) {
        logger.warn('SDK', 'Gemini agent aborted', { sessionId: session.sessionDbId });
        throw error;
      }

      // Rate limit / quota exhaustion: fall back to Claude SDK for this batch,
      // then resume Gemini on the next session cycle.
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED') || errorMsg.includes('quota')) {
        if (this.fallbackAgent && !session.inFallback) {
          logger.info('SDK', 'Gemini quota exhausted, falling back to next provider for this batch', {
            sessionDbId: session.sessionDbId,
          });
          // Reset history — fallback agent manages its own context
          session.conversationHistory = [];
          session.inFallback = true;
          try {
            await this.fallbackAgent.startSession(session, worker);
            return; // fallback processed remaining messages — normal exit
          } catch (fallbackError) {
            logger.warn('SDK', 'Fallback provider also failed, pausing session', {
              sessionDbId: session.sessionDbId,
              error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
            });
          } finally {
            session.inFallback = false;
          }
        }
        // No fallback available or fallback failed — pause for orphan scanner
        logger.warn('SDK', 'Gemini rate limit / quota exhausted, pausing session gracefully', {
          sessionDbId: session.sessionDbId,
          error: errorMsg
        });
        session.quotaPaused = true;
        return;
      }

      logger.failure('SDK', 'Gemini agent error', { sessionDbId: session.sessionDbId }, error as Error);
      throw error;
    }
  }

  /**
   * Convert shared ConversationMessage array to Gemini's contents format
   * Maps 'assistant' role to 'model' for Gemini API compatibility
   */
  private conversationToGeminiContents(history: ConversationMessage[]): GeminiContent[] {
    return history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));
  }

  /**
   * Query Gemini via REST API with full conversation history (multi-turn)
   * Sends the entire conversation context for coherent responses
   */
  private async queryGeminiMultiTurn(
    history: ConversationMessage[],
    apiKey: string,
    model: GeminiModel,
    rateLimitingEnabled: boolean
  ): Promise<{ content: string; tokensUsed?: number }> {
    const contents = this.conversationToGeminiContents(history);
    const totalChars = history.reduce((sum, m) => sum + m.content.length, 0);

    logger.debug('SDK', `Querying Gemini multi-turn (${model})`, {
      turns: history.length,
      totalChars
    });

    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${apiKey}`;

    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Enforce RPM rate limit for free tier (skipped if rate limiting disabled)
      await enforceRateLimitForModel(model, rateLimitingEnabled);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.3,  // Lower temperature for structured extraction
            maxOutputTokens: 4096,
          },
        }),
      });

      if (response.ok) {
        const data = await response.json() as GeminiResponse;

        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
          logger.error('SDK', 'Empty response from Gemini');
          return { content: '' };
        }

        const content = data.candidates[0].content.parts[0].text;
        const tokensUsed = data.usageMetadata?.totalTokenCount;

        return { content, tokensUsed };
      }

      // Not ok — check if retryable
      const errorText = await response.text();
      const isRetryable = response.status === 429 || response.status >= 500;

      if (isRetryable && attempt < MAX_RETRIES) {
        // Parse "Please retry in Xs" from Gemini 429 responses
        let delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        const retryMatch = errorText.match(/retry in ([\d.]+)s/i);
        if (retryMatch) {
          delayMs = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 500; // server-suggested + 500ms buffer
        }
        logger.warn('SDK', `Gemini ${response.status}, retrying in ${delayMs}ms`, {
          attempt: attempt + 1, maxRetries: MAX_RETRIES, status: response.status, model
        });
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      // Not retryable or max retries exhausted — fail immediately
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    // Should not reach here — loop always returns or throws
    throw new Error('Gemini API: max retries exceeded');
  }

  /**
   * Get Gemini configuration from settings or environment
   * Issue #733: Uses centralized ~/.claude-mem/.env for credentials, not random project .env files
   */
  private getGeminiConfig(): { apiKey: string; model: GeminiModel; rateLimitingEnabled: boolean } {
    const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    // API key: check settings first, then centralized claude-mem .env (NOT process.env)
    // This prevents Issue #733 where random project .env files could interfere
    const apiKey = settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY') || '';

    // Model: from settings or default, with validation
    // NOTE: Default is gemini-3-flash-preview — do NOT revert to 2.x models.
    // See GeminiModel type comment for rationale.
    const defaultModel: GeminiModel = 'gemini-3-flash-preview';
    const configuredModel = settings.CLAUDE_MEM_GEMINI_MODEL || defaultModel;
    const validModels: GeminiModel[] = [
      'gemini-3-flash',
      'gemini-3-flash-preview',
    ];

    let model: GeminiModel;
    if (validModels.includes(configuredModel as GeminiModel)) {
      model = configuredModel as GeminiModel;
    } else {
      logger.warn('SDK', `Invalid Gemini model "${configuredModel}", falling back to ${defaultModel}`, {
        configured: configuredModel,
        validModels,
      });
      model = defaultModel;
    }

    // Rate limiting: enabled by default for free tier users
    const rateLimitingEnabled = settings.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED !== 'false';

    return { apiKey, model, rateLimitingEnabled };
  }
}

/**
 * Check if Gemini is available (has API key configured)
 * Issue #733: Uses centralized ~/.claude-mem/.env, not random project .env files
 */
export function isGeminiAvailable(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return !!(settings.CLAUDE_MEM_GEMINI_API_KEY || getCredential('GEMINI_API_KEY'));
}

/**
 * Check if Gemini is the selected provider
 */
export function isGeminiSelected(): boolean {
  const settingsPath = path.join(homedir(), '.claude-mem', 'settings.json');
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);
  return settings.CLAUDE_MEM_PROVIDER === 'gemini';
}
