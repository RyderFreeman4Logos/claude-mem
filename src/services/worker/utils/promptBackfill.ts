import type { SessionStore } from '../../sqlite/SessionStore.js';
import type { VectorSyncBackend } from '../../sync/VectorBackend.js';
import { logger } from '../../../utils/logger.js';

type PromptBackfillLogger = Pick<typeof logger, 'debug' | 'error'>;

/**
 * Backfill every prompt that was stored before a real memory session ID became available.
 */
export async function backfillUnsyncedPrompts(
  sessionStore: SessionStore,
  contentSessionId: string,
  memorySessionId: string,
  targetProject: string,
  vectorSync: VectorSyncBackend | null,
  log: PromptBackfillLogger
): Promise<void> {
  if (!vectorSync) {
    return;
  }

  const prompts = sessionStore.getUnsyncedUserPromptsByContentSessionId(contentSessionId);
  if (prompts.length === 0) {
    return;
  }

  log.debug('CHROMA', 'Backfilling un-synced user prompts after memory session capture', {
    contentSessionId,
    memorySessionId,
    promptCount: prompts.length,
    backend: vectorSync.backend
  });

  for (const prompt of prompts) {
    try {
      await vectorSync.syncUserPrompt(
        prompt.id,
        memorySessionId,
        targetProject,
        prompt.prompt_text,
        prompt.prompt_number,
        prompt.created_at_epoch
      );
      sessionStore.markPromptVectorSynced(prompt.id, Date.now());
    } catch (error) {
      log.error('CHROMA', 'User prompt backfill failed, continuing with remaining prompts', {
        promptId: prompt.id,
        contentSessionId,
        memorySessionId
      }, error as Error);
    }
  }
}
