/**
 * Summarize Handler - Stop
 *
 * Runs in the Stop hook (120s timeout, not capped like SessionEnd).
 * Queues summary work, then returns immediately so the terminal is not blocked.
 *
 * Flow:
 * 1. Queue summarize request to worker
 * 2. Fire-and-forget /api/sessions/complete to clean up session
 *
 * SessionEnd (1.5s cap from Claude Code) is a lightweight fallback if the
 * Stop hook's cleanup request does not land.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { extractLastMessage } from '../../shared/transcript-parser.js';
import { HOOK_EXIT_CODES, HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';

const SUMMARIZE_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.DEFAULT);

export const summarizeHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    // Ensure worker is running before any other logic
    const workerReady = await ensureWorkerRunning();
    if (!workerReady) {
      // Worker not available - skip summary gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const { sessionId, transcriptPath } = input;

    // Validate required fields before processing
    if (!transcriptPath) {
      // No transcript available - skip summary gracefully (not an error)
      logger.debug('HOOK', `No transcriptPath in Stop hook input for session ${sessionId} - skipping summary`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Extract last assistant message from transcript (the work Claude did)
    // Note: "user" messages in transcripts are mostly tool_results, not actual user input.
    // The user's original request is already stored in user_prompts table.
    let lastAssistantMessage = '';
    try {
      lastAssistantMessage = extractLastMessage(transcriptPath, 'assistant', true);
    } catch (err) {
      logger.warn('HOOK', `Stop hook: failed to extract last assistant message for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Skip summary if transcript has no assistant message (prevents repeated
    // empty summarize requests that pollute logs — upstream bug)
    if (!lastAssistantMessage || !lastAssistantMessage.trim()) {
      logger.debug('HOOK', 'No assistant message in transcript - skipping summary', {
        contentSessionId: sessionId,
        transcriptPath
      });
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    logger.dataIn('HOOK', 'Stop: Requesting summary', {
      hasLastAssistantMessage: !!lastAssistantMessage
    });

    // 1. Queue summarize request — worker returns immediately with { status: 'queued' }
    const response = await workerHttpRequest('/api/sessions/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId: sessionId,
        last_assistant_message: lastAssistantMessage
      }),
      timeoutMs: SUMMARIZE_TIMEOUT_MS
    });

    if (!response.ok) {
      return { continue: true, suppressOutput: true };
    }

    logger.debug('HOOK', 'Summary request queued, returning immediately');

    // 2. Complete the session without blocking Stop hook exit.
    void workerHttpRequest('/api/sessions/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentSessionId: sessionId }),
      timeoutMs: 10_000
    })
      .then(() => {
        logger.info('HOOK', 'Session completed in Stop hook', { contentSessionId: sessionId });
      })
      .catch((err) => {
        logger.warn('HOOK', `Stop hook: session-complete failed: ${err instanceof Error ? err.message : err}`);
      });

    return { continue: true, suppressOutput: true };
  }
};
