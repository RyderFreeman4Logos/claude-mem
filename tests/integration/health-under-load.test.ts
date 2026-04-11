import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Database } from 'bun:sqlite';
import { logger } from '../../src/utils/logger.js';
import { Server } from '../../src/services/server/Server.js';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import { PendingMessageStore } from '../../src/services/sqlite/PendingMessageStore.js';
import type { PendingMessage } from '../../src/services/worker-types.js';
import { GlobalMessagePool } from '../../src/services/worker/GlobalMessagePool.js';
import { AsyncSemaphore } from '../../src/services/worker/AsyncSemaphore.js';
import type { ConcurrencyManager } from '../../src/services/worker/ConcurrencyManager.js';

const MESSAGE_COUNT = 6000;
const PROVIDER_DELAY_MS = 50;
const POOL_CONCURRENCY = 10;
const PROBE_INTERVAL_MS = 1000;
const PROBE_DURATION_MS = 30_000;
const HEALTH_TIMEOUT_MS = 500;

function createConcurrencyManagerStub(desiredConcurrency: number): ConcurrencyManager {
  return {
    startWatching: () => {},
    stopWatching: () => {},
    subscribeToChanges: () => () => {},
    getDesiredConcurrency: () => desiredConcurrency
  } as unknown as ConcurrencyManager;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<{
  response: Response;
  body: any;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  const response = await Promise.race([fetch(url), timeoutPromise]);
  const body = await response.json();
  return {
    response,
    body,
    latencyMs: Date.now() - startedAt
  };
}

describe('Health under sustained global pool load', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  let database: ClaudeMemDatabase | null = null;
  let sessionStore: SessionStore | null = null;
  let db: Database | null = null;
  let server: Server | null = null;
  let pool: GlobalMessagePool | null = null;
  let tempDir: string | null = null;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(async () => {
    loggerSpies.forEach((spy) => spy.mockRestore());

    if (pool) {
      await pool.stop();
      pool = null;
    }

    if (server?.getHttpServer()) {
      try {
        await server.close();
      } catch {
        // Ignore cleanup errors after the assertions complete.
      }
      server = null;
    }

    if (sessionStore) {
      sessionStore.db.close();
      sessionStore = null;
    }

    if (database) {
      database.close();
      database = null;
    }

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('keeps /api/health responsive for 30 seconds while processing 6000 messages', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-health-'));
    const dbPath = join(tempDir, 'health-under-load.sqlite');

    database = new ClaudeMemDatabase(dbPath);
    db = database.db;
    sessionStore = new SessionStore(dbPath);

    const pendingStore = new PendingMessageStore(db, 3);
    const sqliteGate = new AsyncSemaphore(2);
    const contentSessionId = 'health-under-load-session';
    const project = 'health-under-load-project';
    const sessionDbId = createSDKSession(db, contentSessionId, project, 'Sustained load prompt');
    const memorySessionId = `memory-${sessionDbId}`;

    const port = 40000 + Math.floor(Math.random() * 10000);
    const healthUrl = `http://127.0.0.1:${port}/api/health`;

    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      const message: PendingMessage = {
        type: 'observation',
        tool_name: 'LoadTestTool',
        tool_input: { index },
        tool_response: { index },
        prompt_number: index + 1
      };
      pendingStore.enqueue(sessionDbId, contentSessionId, message);
    }

    let processedCount = 0;

    pool = new GlobalMessagePool(
      pendingStore,
      createConcurrencyManagerStub(POOL_CONCURRENCY),
      async (message) => {
        await delay(PROVIDER_DELAY_MS);

        await sqliteGate.run('store', () => {
          sessionStore!.ensureMemorySessionIdRegistered(sessionDbId, memorySessionId);
          sessionStore!.storeObservations(
            memorySessionId,
            project,
            [{
              type: 'discovery',
              title: `Processed message ${message.id}`,
              subtitle: null,
              facts: [`message:${message.id}`],
              narrative: `Stored observation for message ${message.id}`,
              concepts: ['load-test'],
              files_read: ['tests/integration/health-under-load.test.ts'],
              files_modified: []
            }],
            null,
            message.prompt_number ?? 1,
            0,
            message.created_at_epoch
          );
          pendingStore.confirmProcessed(message.id);
        });

        processedCount += 1;
      },
      undefined,
      sqliteGate
    );

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: async () => {},
      onRestart: async () => {},
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'cli',
        lastInteraction: null
      }),
      getPoolStatus: () => pool!.getStatus()
    });

    await server.listen(port, '127.0.0.1');
    pool.start();

    const probeLatencies: number[] = [];
    const tickValues: number[] = [];
    const processingSnapshots: number[] = [];
    const probeDeadline = Date.now() + PROBE_DURATION_MS;

    try {
      while (Date.now() < probeDeadline) {
        const probeStartedAt = Date.now();
        const { response, body, latencyMs } = await fetchJsonWithTimeout(healthUrl, HEALTH_TIMEOUT_MS);

        probeLatencies.push(latencyMs);
        tickValues.push(body.pool.lastTickMs ?? 0);
        processingSnapshots.push(body.pool.processingCount ?? 0);

        expect(response.status).toBe(200);
        expect(latencyMs).toBeLessThan(HEALTH_TIMEOUT_MS);

        const remainingSleepMs = PROBE_INTERVAL_MS - (Date.now() - probeStartedAt);
        if (remainingSleepMs > 0) {
          await delay(remainingSleepMs);
        }
      }

      expect(probeLatencies.length).toBeGreaterThanOrEqual(25);
      expect(probeLatencies.every((latencyMs) => latencyMs < HEALTH_TIMEOUT_MS)).toBe(true);
      expect(processedCount).toBeGreaterThan(500);
      expect(processingSnapshots.some((count) => count > 0)).toBe(true);

      const observedTicks = tickValues.filter((tick) => tick > 0);
      expect(observedTicks.length).toBeGreaterThan(0);
      expect(Math.max(...observedTicks)).toBeGreaterThan(Math.min(...observedTicks));
      expect(pool.getStatus().poolSize).toBe(POOL_CONCURRENCY);
    } finally {
      await pool.stop();
      pool = null;
    }

    const processingRow = db.query(`
      SELECT COUNT(*) as count
      FROM pending_messages
      WHERE status = 'processing'
    `).get() as { count: number };

    expect(processingRow.count).toBe(0);
  }, 60_000);
});
