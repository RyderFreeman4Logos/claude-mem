/**
 * Observation Handler - PostToolUse
 *
 * Extracted from save-hook.ts - sends tool usage to worker for storage.
 */

import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { ensureWorkerRunning, workerHttpRequest } from '../../shared/worker-utils.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { isProjectExcluded } from '../../utils/project-filter.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

const POSTTOOLUSE_ENQUEUE_TIMEOUT_MS = 200;

export const observationHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId, cwd, toolName, toolInput, toolResponse } = input;
    const platformSource = normalizePlatformSource(input.platform);

    if (!toolName) {
      // No tool name provided - skip observation gracefully
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const toolStr = logger.formatTool(toolName, toolInput);

    logger.dataIn('HOOK', `PostToolUse: ${toolStr}`, {});

    // Validate required fields before sending to worker
    if (!cwd) {
      throw new Error(`Missing cwd in PostToolUse hook input for session ${sessionId}, tool ${toolName}`);
    }

    // Check if project is excluded from tracking
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (isProjectExcluded(cwd, settings.CLAUDE_MEM_EXCLUDED_PROJECTS)) {
      logger.debug('HOOK', 'Project excluded from tracking, skipping observation', { cwd, toolName });
      return { continue: true, suppressOutput: true };
    }

    const requestBody = JSON.stringify({
      contentSessionId: sessionId,
      platformSource,
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: toolResponse,
      cwd
    });

    // Bound the full enqueue path so hook-command.ts can exit promptly without
    // dropping observations that were still waiting on the background promise chain.
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), POSTTOOLUSE_ENQUEUE_TIMEOUT_MS)
    );
    const enqueuePromise = (async () => {
      const workerReady = await ensureWorkerRunning();
      if (!workerReady) {
        logger.debug('HOOK', 'Observation enqueue skipped, worker not healthy', { toolName });
        return 'skipped' as const;
      }

      const response = await workerHttpRequest('/api/sessions/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      if (!response.ok) {
        logger.warn('HOOK', 'Observation storage failed, skipping', { status: response.status, toolName });
        return 'failed' as const;
      }

      logger.debug('HOOK', 'Observation sent successfully', { toolName });
      return 'ok' as const;
    })();

    try {
      const outcome = await Promise.race([enqueuePromise, timeoutPromise]);
      if (outcome === null) {
        logger.debug('HOOK', 'PostToolUse observation enqueue timed out at 200ms, dropped', {
          toolName,
          timeoutMs: POSTTOOLUSE_ENQUEUE_TIMEOUT_MS,
        });
      }
    } catch (error) {
      logger.warn('HOOK', 'Observation enqueue failed', {
        error: error instanceof Error ? error.message : String(error),
        toolName,
      });
    }

    return { continue: true, suppressOutput: true };
  }
};
