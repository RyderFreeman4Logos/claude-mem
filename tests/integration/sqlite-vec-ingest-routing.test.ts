import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

mock.module('../../src/services/integrations/CursorHooksInstaller.js', () => ({
  updateCursorContextForProject: () => Promise.resolve(),
}));

mock.module('../../src/shared/worker-utils.js', () => ({
  getWorkerPort: () => 37777,
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({
        name: 'code',
        prompts: {
          init: 'init prompt',
          observation: 'obs prompt',
          summary: 'summary prompt',
        },
        observation_types: [{ id: 'discovery' }, { id: 'bugfix' }, { id: 'decision' }],
        observation_concepts: [],
      }),
    }),
  },
}));

import { processAgentResponse } from '../../src/services/worker/agents/ResponseProcessor.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { EmbeddingClient } from '../../src/services/sync/EmbeddingClient.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

function makeEmbedding(seed: number): number[] {
  return Array.from({ length: 4096 }, () => seed);
}

describe('sqlite-vec ingest routing', () => {
  let tempRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    tempRoot = join(tmpdir(), `claude-mem-sqlite-vec-ingest-${randomUUID()}`);
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
      CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: false,
    } as any);

    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);
  });

  afterEach(async () => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    mock.restore();
    (EmbeddingClient as any).instance = null;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('writes observations and summaries into sqlite-vec chunks when sqlite-vec is selected', async () => {
    const dbPath = join(tempRoot, 'claude-mem.db');
    const dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();

    const vectorSync = dbManager.getVectorSync();
    expect(vectorSync?.backend).toBe('sqlite-vec');

    const pendingSyncs: Promise<void>[] = [];
    const originalSyncObservation = vectorSync!.syncObservation.bind(vectorSync);
    const originalSyncSummary = vectorSync!.syncSummary.bind(vectorSync);

    spyOn(vectorSync!, 'syncObservation').mockImplementation((...args) => {
      const promise = originalSyncObservation(...args);
      pendingSyncs.push(promise);
      return promise;
    });

    spyOn(vectorSync!, 'syncSummary').mockImplementation((...args) => {
      const promise = originalSyncSummary(...args);
      pendingSyncs.push(promise);
      return promise;
    });

    const store = dbManager.getSessionStore();
    const sessionDbId = store.createSDKSession(
      'content-session-1',
      'test-project',
      'Investigate vector backend routing',
      undefined,
      'claude'
    );
    store.saveUserPrompt('content-session-1', 1, 'Investigate vector backend routing');

    const sessionManager = new SessionManager(dbManager);
    const session = sessionManager.initializeSession(
      sessionDbId,
      'Investigate vector backend routing',
      1
    );
    session.memorySessionId = 'memory-session-1';

    await processAgentResponse(
      `
      <observation>
        <type>decision</type>
        <title>Route ingest through vector backend</title>
        <subtitle>sqlite-vec should receive fresh writes</subtitle>
        <narrative>Observation ingest must use the selected vector backend instead of hard-coded Chroma sync.</narrative>
        <facts><fact>sqlite-vec is enabled</fact></facts>
        <concepts><concept>vector-backend</concept></concepts>
        <files_read><file>src/services/worker/agents/ResponseProcessor.ts</file></files_read>
        <files_modified><file>src/services/worker/DatabaseManager.ts</file></files_modified>
      </observation>
      <summary>
        <request>Fix vector backend routing</request>
        <investigated>Observation ingest paths</investigated>
        <learned>sqlite-vec must receive live writes</learned>
        <completed>Routed ingest through the active backend</completed>
        <next_steps>Ship regression coverage</next_steps>
      </summary>
      `,
      session,
      dbManager,
      sessionManager,
      undefined,
      7,
      Date.now(),
      'TestAgent'
    );

    await Promise.all(pendingSyncs);

    const observation = store.db.prepare(`
      SELECT id
      FROM observations
      WHERE memory_session_id = ?
      LIMIT 1
    `).get('memory-session-1') as { id: number };
    const summary = store.db.prepare(`
      SELECT id
      FROM session_summaries
      WHERE memory_session_id = ?
      LIMIT 1
    `).get('memory-session-1') as { id: number };

    const observationChunks = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM claude_mem_vec_chunks
      WHERE sqlite_id = ? AND doc_type = 'observation' AND project = ?
    `).get(observation.id, 'test-project') as { count: number };
    const summaryChunks = store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM claude_mem_vec_chunks
      WHERE sqlite_id = ? AND doc_type = 'session_summary' AND project = ?
    `).get(summary.id, 'test-project') as { count: number };

    expect(observationChunks.count).toBeGreaterThan(0);
    expect(summaryChunks.count).toBeGreaterThan(0);

    await dbManager.close();
  });
});
