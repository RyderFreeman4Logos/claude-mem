import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { EmbeddingClient } from '../../src/services/sync/EmbeddingClient.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

function makeEmbedding(seed: number): number[] {
  return Array.from({ length: 4096 }, () => seed);
}

describe('SessionRoutes vector sync routing', () => {
  let tempRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    tempRoot = join(tmpdir(), `claude-mem-session-routes-${randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    (EmbeddingClient as any).instance = null;

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      CLAUDE_MEM_VECTOR_BACKEND: 'sqlite-vec',
      CLAUDE_MEM_CHROMA_ENABLED: 'true',
    } as any);

    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);
  });

  afterEach(() => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    mock.restore();
    (EmbeddingClient as any).instance = null;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('syncs the latest user prompt through the active vector backend', async () => {
    const dbPath = join(tempRoot, 'claude-mem.db');
    const dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();

    const store = dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(
      'content-session-1',
      'test-project',
      'Investigate prompt routing',
      undefined,
      'claude'
    );
    store.updateMemorySessionId(sessionDbId, 'memory-session-1');
    const promptId = store.saveUserPrompt('content-session-1', 1, 'Investigate prompt routing');

    const sessionManager = new SessionManager(dbManager);
    const vectorSync = dbManager.getVectorSync();
    expect(vectorSync?.backend).toBe('sqlite-vec');

    const pendingSyncs: Promise<void>[] = [];
    const originalSyncUserPrompt = vectorSync!.syncUserPrompt.bind(vectorSync);
    spyOn(vectorSync!, 'syncUserPrompt').mockImplementation((...args) => {
      const promise = originalSyncUserPrompt(...args);
      pendingSyncs.push(promise);
      return promise;
    });

    const routes = new SessionRoutes(
      sessionManager,
      dbManager,
      {} as any,
      {} as any,
      {} as any,
      {
        broadcastNewPrompt: mock(() => {}),
        broadcastSessionStarted: mock(() => {}),
      } as any,
      {
        notifyGlobalMessagePool: mock(() => {}),
      } as any
    );

    const req = {
      params: { sessionDbId: String(sessionDbId) },
      body: { userPrompt: 'Investigate prompt routing', promptNumber: 1 },
      path: `/sessions/${sessionDbId}/init`
    } as any;
    const res = {
      headersSent: false,
      status: mock(function status() { return res; }),
      json: mock(() => res)
    } as any;

    (routes as any).handleSessionInit(req, res);
    await Promise.all(pendingSyncs);

    const promptChunks = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM claude_mem_vec_chunks
      WHERE sqlite_id = ? AND doc_type = 'user_prompt' AND project = ?
    `).get(promptId, 'test-project') as { count: number };

    expect(promptChunks.count).toBeGreaterThan(0);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'initialized',
      sessionDbId,
      port: 37777
    }));

    await dbManager.close();
  });
});
