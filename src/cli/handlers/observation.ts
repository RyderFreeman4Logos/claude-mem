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

    // Fire-and-forget observation enqueue — PostToolUse does not need the worker response.
    void ensureWorkerRunning()
      .then(async (workerReady) => {
        if (!workerReady) {
          logger.debug('HOOK', 'Observation enqueue skipped, worker not healthy', { toolName });
          return;
        }

        const response = await workerHttpRequest('/api/sessions/observations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentSessionId: sessionId,
            platformSource,
            tool_name: toolName,
            tool_input: toolInput,
            tool_response: toolResponse,
            cwd
          })
        });

        if (!response.ok) {
          logger.warn('HOOK', 'Observation storage failed, skipping', { status: response.status, toolName });
          return;
        }

        logger.debug('HOOK', 'Observation sent successfully', { toolName });
      })
      .catch((error) => {
        logger.warn('HOOK', 'Observation enqueue fire-and-forget failed', {
          error: error instanceof Error ? error.message : String(error),
          toolName,
        });
      });

    return { continue: true, suppressOutput: true };
  }
};
