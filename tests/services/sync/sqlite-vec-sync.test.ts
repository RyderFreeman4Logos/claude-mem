import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { EmbeddingClient } from '../../../src/services/sync/EmbeddingClient.js';
import { SqliteVecSync } from '../../../src/services/sync/SqliteVecSync.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

function makeEmbedding(seed: number, dim = 4096): number[] {
  return Array.from({ length: dim }, () => seed);
}

describe('SqliteVecSync', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `claude-mem-sqlite-vec-${randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    (EmbeddingClient as any).instance = null;
    mock.restore();
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      CLAUDE_MEM_EMBED_DIM: '4096'
    } as any);
  });

  afterEach(() => {
    (EmbeddingClient as any).instance = null;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('syncs, queries, and deletes vectors in sqlite-vec', async () => {
    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);

    const sync = new SqliteVecSync('test-project', ':memory:');

    await sync.syncObservation(
      1,
      'memory-session',
      'test-project',
      {
        type: 'decision',
        title: 'SQLite vec',
        subtitle: null,
        facts: [],
        narrative: 'store this narrative',
        concepts: ['vector'],
        files_read: ['src/a.ts'],
        files_modified: ['src/b.ts']
      },
      1,
      Date.now()
    );

    const queried = await sync.queryChroma('store this narrative', 5, { project: 'test-project' });
    expect(queried.notReady).toBeUndefined();
    expect(queried.disabled).toBeUndefined();
    expect(queried.ids).toEqual([1]);
    expect(queried.metadatas[0]).toEqual(expect.objectContaining({
      sqlite_id: 1,
      doc_type: 'observation',
      project: 'test-project',
      field_type: 'narrative'
    }));

    await sync.deleteBySqliteId(1);

    const afterDelete = await sync.queryChroma('store this narrative', 5, { project: 'test-project' });
    expect(afterDelete.ids).toEqual([]);

    await sync.close();
  });

  it('returns backend-not-ready when source data exists but sqlite-vec migration has not completed', async () => {
    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);

    const dbPath = join(tempRoot, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    store.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id,
        memory_session_id,
        project,
        platform_source,
        user_prompt,
        started_at,
        started_at_epoch,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'content-1',
      'memory-1',
      'test-project',
      'claude',
      'test prompt',
      new Date().toISOString(),
      Date.now(),
      'completed'
    );
    store.db.prepare(`
      INSERT INTO observations (
        memory_session_id,
        project,
        text,
        type,
        created_at,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'memory-1',
      'test-project',
      'source observation',
      'decision',
      new Date().toISOString(),
      Date.now()
    );
    store.close();

    const sync = new SqliteVecSync('test-project', dbPath);
    const result = await sync.queryChroma('source observation', 5, { project: 'test-project' });

    expect(result.notReady).toBe(true);
    expect(result.message).toContain('migrate-chroma-to-sqlite-vec.py');

    await sync.close();
  });

  it('checks readiness against the requested project instead of the backend instance label', async () => {
    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);

    const dbPath = join(tempRoot, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const now = Date.now();

    store.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id,
        memory_session_id,
        project,
        platform_source,
        user_prompt,
        started_at,
        started_at_epoch,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'content-b',
      'memory-b',
      'project-b',
      'claude',
      'test prompt',
      new Date(now).toISOString(),
      now,
      'completed'
    );
    store.db.prepare(`
      INSERT INTO observations (
        id,
        memory_session_id,
        project,
        text,
        type,
        title,
        subtitle,
        facts,
        narrative,
        concepts,
        files_read,
        files_modified,
        prompt_number,
        discovery_tokens,
        created_at,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      2,
      'memory-b',
      'project-b',
      'source observation',
      'decision',
      'Project B',
      null,
      '[]',
      'source observation',
      '[]',
      '[]',
      '[]',
      1,
      0,
      new Date(now).toISOString(),
      now
    );
    store.close();

    const sharedBackend = new SqliteVecSync('claude-mem', dbPath);
    const result = await sharedBackend.queryChroma('source observation', 5, { project: 'project-b' });

    expect(result.notReady).toBe(true);
    expect(result.message).toContain('sqlite-vec backend not ready');

    await sharedBackend.close();
  });

  it('keeps sqlite-vec queries not-ready when migration state is partial', async () => {
    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);

    const sync = new SqliteVecSync('test-project', ':memory:');
    await (sync as any).ensureDatabaseReady();
    (sync as any).db.prepare(`
      INSERT INTO claude_mem_vec_state (
        state_key,
        status,
        source,
        started_at_epoch,
        completed_at_epoch,
        last_error
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'sqlite_vec_readiness',
      'partial',
      'chroma-qwen3',
      Date.now(),
      Date.now(),
      null
    );

    const result = await sync.queryChroma('source observation', 5, { project: 'test-project' });
    expect(result.notReady).toBe(true);
    expect(result.message).toContain('sqlite-vec backend not ready');

    await sync.close();
  });

  it('uses the configured embedding dimension for sqlite-vec tables', async () => {
    (SettingsDefaultsManager.loadFromFile as any).mockReturnValue({
      CLAUDE_MEM_EMBED_DIM: '8'
    } as any);
    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1, 8))),
      embedQuery: mock(async () => makeEmbedding(1, 8)),
      getConfig: () => ({ model: 'test-model', dim: 8 })
    } as any);

    const sync = new SqliteVecSync('test-project', ':memory:');

    await sync.syncObservation(
      1,
      'memory-session',
      'test-project',
      {
        type: 'decision',
        title: 'SQLite vec',
        subtitle: null,
        facts: [],
        narrative: 'store this narrative',
        concepts: ['vector'],
        files_read: ['src/a.ts'],
        files_modified: ['src/b.ts']
      },
      1,
      Date.now()
    );

    const queried = await sync.queryChroma('store this narrative', 5, { project: 'test-project' });
    expect(queried.ids).toEqual([1]);

    await sync.close();
  });

  it('keeps global sqlite-vec queries not-ready when source data exists without a readiness row', async () => {
    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);

    const dbPath = join(tempRoot, 'global-readiness.db');
    const store = new SessionStore(dbPath);
    const now = Date.now();

    store.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id,
        memory_session_id,
        project,
        platform_source,
        user_prompt,
        started_at,
        started_at_epoch,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'content-a',
      'memory-a',
      'project-a',
      'claude',
      'test prompt',
      new Date(now).toISOString(),
      now,
      'completed'
    );
    store.db.prepare(`
      INSERT INTO observations (
        id,
        memory_session_id,
        project,
        text,
        type,
        title,
        subtitle,
        facts,
        narrative,
        concepts,
        files_read,
        files_modified,
        prompt_number,
        discovery_tokens,
        created_at,
        created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      'memory-a',
      'project-a',
      'source observation',
      'decision',
      'Project A',
      null,
      '[]',
      'source observation',
      '[]',
      '[]',
      '[]',
      1,
      0,
      new Date(now).toISOString(),
      now
    );
    store.close();

    const sync = new SqliteVecSync('test-project', dbPath);

    await sync.syncObservation(
      2,
      'memory-session',
      'test-project',
      {
        type: 'decision',
        title: 'SQLite vec',
        subtitle: null,
        facts: [],
        narrative: 'store this narrative',
        concepts: ['vector'],
        files_read: ['src/a.ts'],
        files_modified: ['src/b.ts']
      },
      1,
      Date.now()
    );

    const queried = await sync.queryChroma('store this narrative', 5);
    expect(queried.notReady).toBe(true);
    expect(queried.message).toContain('sqlite-vec backend not ready');

    await sync.close();
  });
});
