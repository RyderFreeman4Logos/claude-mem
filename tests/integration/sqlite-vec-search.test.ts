import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { SqliteVecSync } from '../../src/services/sync/SqliteVecSync.js';
import { EmbeddingClient } from '../../src/services/sync/EmbeddingClient.js';
import { SearchManager } from '../../src/services/worker/SearchManager.js';

function makeEmbedding(seed: number): number[] {
  return Array.from({ length: 4096 }, () => seed);
}

describe('sqlite-vec search integration', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `claude-mem-sqlite-vec-int-${randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });
    (EmbeddingClient as any).instance = null;
    mock.restore();

    spyOn(EmbeddingClient, 'getInstance').mockReturnValue({
      embedDocuments: mock(async (docs: string[]) => docs.map((_doc, index) => makeEmbedding(index + 1))),
      embedQuery: mock(async () => makeEmbedding(1)),
      getConfig: () => ({ model: 'test-model', dim: 4096 })
    } as any);
  });

  afterEach(() => {
    (EmbeddingClient as any).instance = null;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns consistent search json in sqlite-vec mode', async () => {
    const dbPath = join(tempRoot, 'claude-mem.db');
    const store = new SessionStore(dbPath);
    const search = new SessionSearch(dbPath);
    const vec = new SqliteVecSync('test-project', dbPath);

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
      'content-1',
      'memory-1',
      'test-project',
      'claude',
      'search integration',
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
      'memory-1',
      'test-project',
      'vector search text',
      'decision',
      'SQLite Vec Search',
      null,
      '[]',
      'vector search text',
      '["vector"]',
      '["src/a.ts"]',
      '["src/b.ts"]',
      1,
      0,
      new Date(now).toISOString(),
      now
    );

    await vec.syncObservation(
      1,
      'memory-1',
      'test-project',
      {
        type: 'decision',
        title: 'SQLite Vec Search',
        subtitle: null,
        facts: [],
        narrative: 'vector search text',
        concepts: ['vector'],
        files_read: ['src/a.ts'],
        files_modified: ['src/b.ts']
      },
      1,
      now
    );

    const manager = new SearchManager(search, store, vec as any, {} as any, {} as any);
    const result = await manager.search({
      query: 'vector search text',
      project: 'test-project',
      format: 'json'
    });

    expect(result.vectorBackendNotReady).toBe(false);
    expect(result.semanticSearchDisabled).toBe(false);
    expect(result.totalResults).toBe(1);
    expect(result.observations[0]).toEqual(expect.objectContaining({
      id: 1,
      project: 'test-project',
      title: 'SQLite Vec Search',
      type: 'decision'
    }));

    await vec.close();
    store.close();
  });
});
