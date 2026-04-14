import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { backfillUnsyncedPrompts } from '../../src/services/worker/utils/promptBackfill.js';
import { logger } from '../../src/utils/logger.js';

describe('promptBackfill', () => {
  let store: SessionStore;
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    store = new SessionStore(':memory:');
    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {})
    ];
  });

  afterEach(() => {
    store.close();
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function createSession(contentSessionId: string, project: string = 'test-project'): void {
    store.createSDKSession(contentSessionId, project, 'initial prompt');
  }

  it('is a no-op when vector sync is disabled', async () => {
    createSession('no-vector-sync');
    const promptId = store.saveUserPrompt('no-vector-sync', 1, 'No backend available');

    await backfillUnsyncedPrompts(
      store,
      'no-vector-sync',
      'memory-session-1',
      'test-project',
      null,
      logger
    );

    const prompt = store.db.prepare('SELECT vector_synced_at FROM user_prompts WHERE id = ?').get(promptId) as {
      vector_synced_at: number | null;
    };
    expect(prompt.vector_synced_at).toBeNull();
  });

  it('syncs all un-synced prompts and marks them in id order', async () => {
    createSession('sync-all-prompts');
    const prompt1Id = store.saveUserPrompt('sync-all-prompts', 1, 'First prompt');
    const prompt2Id = store.saveUserPrompt('sync-all-prompts', 2, 'Second prompt');

    const syncCalls: number[] = [];
    const vectorSync = {
      backend: 'sqlite-vec',
      syncUserPrompt: mock(async (promptId: number) => {
        syncCalls.push(promptId);
      })
    } as any;

    await backfillUnsyncedPrompts(
      store,
      'sync-all-prompts',
      'memory-session-2',
      'test-project',
      vectorSync,
      logger
    );

    const rows = store.db.prepare(`
      SELECT id, vector_synced_at
      FROM user_prompts
      WHERE content_session_id = ?
      ORDER BY id ASC
    `).all('sync-all-prompts') as Array<{ id: number; vector_synced_at: number | null }>;

    expect(syncCalls).toEqual([prompt1Id, prompt2Id]);
    expect(rows).toEqual([
      expect.objectContaining({ id: prompt1Id, vector_synced_at: expect.any(Number) }),
      expect.objectContaining({ id: prompt2Id, vector_synced_at: expect.any(Number) }),
    ]);
  });

  it('continues after a per-prompt sync failure', async () => {
    createSession('sync-error-continue');
    const prompt1Id = store.saveUserPrompt('sync-error-continue', 1, 'Fails first');
    const prompt2Id = store.saveUserPrompt('sync-error-continue', 2, 'Succeeds second');

    const vectorSync = {
      backend: 'sqlite-vec',
      syncUserPrompt: mock(async (promptId: number) => {
        if (promptId === prompt1Id) {
          throw new Error('boom');
        }
      })
    } as any;

    await backfillUnsyncedPrompts(
      store,
      'sync-error-continue',
      'memory-session-3',
      'test-project',
      vectorSync,
      logger
    );

    const rows = store.db.prepare(`
      SELECT id, vector_synced_at
      FROM user_prompts
      WHERE content_session_id = ?
      ORDER BY id ASC
    `).all('sync-error-continue') as Array<{ id: number; vector_synced_at: number | null }>;

    expect(rows).toEqual([
      { id: prompt1Id, vector_synced_at: null },
      expect.objectContaining({ id: prompt2Id, vector_synced_at: expect.any(Number) })
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
