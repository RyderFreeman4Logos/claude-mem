import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import express from 'express';
import { mkdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';

describe('MemoryRoutes disabled vector sync', () => {
  let tempRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    tempRoot = join(tmpdir(), `claude-mem-memory-routes-${randomUUID()}`);
    mkdirSync(tempRoot, { recursive: true });

    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
    ];

    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      CLAUDE_MEM_VECTOR_BACKEND: '',
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
    } as any);
  });

  afterEach(() => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    mock.restore();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('stores a manual observation when vector sync is disabled', async () => {
    const dbPath = join(tempRoot, 'claude-mem.db');
    const dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();

    expect(dbManager.getVectorSync()).toBeNull();

    const routes = new MemoryRoutes(dbManager, 'test-project');
    const app = express();
    app.use(express.json());
    routes.setupRoutes(app);

    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('listening', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Test server failed to start');
      }

      const response = await fetch(`http://127.0.0.1:${address.port}/api/memory/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Manual memory capture for a disabled vector backend.',
          title: 'Disabled backend memory',
        }),
      });

      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body).toEqual(expect.objectContaining({
        success: true,
        title: 'Disabled backend memory',
        project: 'test-project',
      }));

      const store = dbManager.getSessionStore();
      const observation = store.db.prepare(`
        SELECT id, memory_session_id, project, title, narrative
        FROM observations
        WHERE id = ?
      `).get(body.id) as {
        id: number;
        memory_session_id: string;
        project: string;
        title: string;
        narrative: string;
      } | undefined;

      expect(observation).toEqual(expect.objectContaining({
        memory_session_id: 'manual-test-project',
        project: 'test-project',
        title: 'Disabled backend memory',
        narrative: 'Manual memory capture for a disabled vector backend.',
      }));

      const session = store.db.prepare(`
        SELECT memory_session_id, project
        FROM sdk_sessions
        WHERE memory_session_id = ?
      `).get('manual-test-project') as {
        memory_session_id: string;
        project: string;
      } | undefined;

      expect(session).toEqual({
        memory_session_id: 'manual-test-project',
        project: 'test-project',
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await dbManager.close();
    }
  });
});
