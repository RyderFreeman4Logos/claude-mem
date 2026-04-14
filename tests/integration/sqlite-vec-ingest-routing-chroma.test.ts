import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { ChromaSync } from '../../src/services/sync/ChromaSync.js';
import { SqliteVecSync } from '../../src/services/sync/SqliteVecSync.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('chroma backend leaves sqlite-vec chunks empty', () => {
  let tempRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    tempRoot = join(tmpdir(), `claude-mem-chroma-noop-${randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      CLAUDE_MEM_VECTOR_BACKEND: 'chroma',
      CLAUDE_MEM_CHROMA_ENABLED: 'true',
      CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: false,
    } as any);
  });

  afterEach(() => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('selects ChromaSync (not SqliteVecSync) and never creates the vec_chunks table', async () => {
    const dbPath = join(tempRoot, 'claude-mem.db');
    const dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();

    const vectorSync = dbManager.getVectorSync();
    expect(vectorSync).toBeInstanceOf(ChromaSync);
    expect(vectorSync).not.toBeInstanceOf(SqliteVecSync);
    expect(vectorSync?.backend).toBe('chroma');

    const store = dbManager.getSessionStore();

    // Negative coverage: when chroma is the active backend, the sqlite-vec
    // ingest path is structurally absent — it never gets a chance to create
    // its tables, so vec_chunks must not exist (or, if a sibling test
    // pre-created it in the same DB, must be empty).
    const tableRow = store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='claude_mem_vec_chunks'
    `).get() as { name: string } | null;

    expect(tableRow).toBeNull();

    await dbManager.close();
  });
});
