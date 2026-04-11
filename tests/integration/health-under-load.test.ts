import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { logger } from '../../src/utils/logger.js';
import { Server } from '../../src/services/server/Server.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { OpenRouterAgent } from '../../src/services/worker/OpenRouterAgent.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../src/services/worker-types.js';
import { GlobalMessagePool } from '../../src/services/worker/GlobalMessagePool.js';
import { SqliteWriter } from '../../src/services/worker/storage/SqliteWriter.js';
import type { ConcurrencyManager } from '../../src/services/worker/ConcurrencyManager.js';
import { WorkerService } from '../../src/services/worker-service.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { MockOpenRouterProxy } from '../helpers/mock-openrouter-proxy.js';

const MESSAGE_COUNT = 60;
const EXPECTED_REQUESTS = MESSAGE_COUNT * 2;
const PROVIDER_DELAY_MS = 150;
const PERSIST_DELAY_MS = 60;
const POOL_CONCURRENCY = 10;
const PROBE_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 500;
const DRAIN_TIMEOUT_MS = 20_000;

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

async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }

  throw new Error(message);
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

function computeP95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
}

describe('Health under sustained real sender load', () => {
  let loggerSpies: ReturnType<typeof spyOn>[] = [];
  let tempDir: string | null = null;
  let dbManager: DatabaseManager | null = null;
  let sessionManager: SessionManager | null = null;
  let storageCoordinator: SqliteWriter | null = null;
  let server: Server | null = null;
  let pool: GlobalMessagePool | null = null;
  let proxy: MockOpenRouterProxy | null = null;
  let originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
      spyOn(logger, 'success').mockImplementation(() => {}),
      spyOn(logger, 'failure').mockImplementation(() => {}),
      spyOn(logger, 'dataOut').mockImplementation(() => {})
    ];

    originalEnv = {
      CLAUDE_MEM_OPENROUTER_API_KEY: process.env.CLAUDE_MEM_OPENROUTER_API_KEY,
      CLAUDE_MEM_OPENROUTER_MODEL: process.env.CLAUDE_MEM_OPENROUTER_MODEL,
      CLAUDE_MEM_OPENROUTER_BASE_URL: process.env.CLAUDE_MEM_OPENROUTER_BASE_URL,
      CLAUDE_MEM_PROVIDER: process.env.CLAUDE_MEM_PROVIDER,
      CLAUDE_MEM_CHROMA_ENABLED: process.env.CLAUDE_MEM_CHROMA_ENABLED
    };
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
        // Best-effort cleanup after failed startup/assertions.
      }
      server = null;
    }

    if (storageCoordinator) {
      await storageCoordinator.shutdown();
      storageCoordinator = null;
    }

    if (proxy) {
      await proxy.stop();
      proxy = null;
    }

    if (dbManager) {
      await dbManager.close();
      dbManager = null;
    }

    sessionManager = null;

    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    SettingsDefaultsManager.clearCache();
  });

  test('keeps sender concurrency near target while persistence backlog drains independently', async () => {
    tempDir = mkdtempSync(join(process.cwd(), '.tmp-health-under-load-'));
    const dbPath = join(tempDir, 'health-under-load.sqlite');
    const contentSessionId = 'health-under-load-session';
    const project = 'health-under-load-project';

    proxy = new MockOpenRouterProxy(PROVIDER_DELAY_MS);
    await proxy.start();

    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'test-openrouter-key';
    process.env.CLAUDE_MEM_OPENROUTER_MODEL = 'test/mock-model';
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = proxy.getUrl();
    process.env.CLAUDE_MEM_PROVIDER = 'openrouter';
    process.env.CLAUDE_MEM_CHROMA_ENABLED = 'false';
    SettingsDefaultsManager.clearCache();

    dbManager = new DatabaseManager(dbPath);
    await dbManager.initialize();
    sessionManager = new SessionManager(dbManager);

    const sessionStore = dbManager.getSessionStore();
    const sessionDbId = createSDKSession(sessionStore.db, contentSessionId, project, 'Sustained load prompt');
    const pendingStore = sessionManager.getPendingMessageStore();

    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
      const message: PendingMessage = {
        type: 'observation',
        tool_name: 'LoadTestTool',
        tool_input: { index },
        tool_response: { index },
        prompt_number: index + 1,
        cwd: process.cwd()
      };
      pendingStore.enqueue(sessionDbId, contentSessionId, message);
    }

    storageCoordinator = new SqliteWriter(dbPath, { commitDelayMs: PERSIST_DELAY_MS });
    await storageCoordinator.start();

    ModeManager.getInstance().loadMode('code');
    const openRouterAgent = new OpenRouterAgent(dbManager, sessionManager);
    const broadcastProcessingStatus = () => {};
    const fakeWorkerService = {
      sdkAgent: {},
      sessionManager,
      openRouterAgent,
      storageCoordinator,
      sseBroadcaster: {
        broadcast: () => {}
      },
      createIsolatedClaimedSession: (WorkerService.prototype as any).createIsolatedClaimedSession,
      getActiveAgent: () => openRouterAgent,
      applyTierRouting: () => {},
      broadcastProcessingStatus,
      lastAiInteraction: null
    };

    pool = new GlobalMessagePool(
      createConcurrencyManagerStub(POOL_CONCURRENCY),
      async (message) => {
        await (WorkerService.prototype as any).processClaimedSessionMessage.call(fakeWorkerService, message);
      },
      async () => storageCoordinator!.claimNextMessage()
    );

    const port = 40000 + Math.floor(Math.random() * 10000);
    const healthUrl = `http://127.0.0.1:${port}/api/health`;

    server = new Server({
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: async () => {},
      onRestart: async () => {},
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'openrouter',
        authMethod: 'test',
        lastInteraction: null
      }),
      getPoolStatus: () => pool!.getStatus()
    });

    await server.listen(port, '127.0.0.1');

    const probeLatencies: number[] = [];
    const processingSnapshots: number[] = [];
    let stopProbing = false;
    const probeLoop = (async () => {
      while (!stopProbing) {
        const probeStartedAt = Date.now();
        const { response, body, latencyMs } = await fetchJsonWithTimeout(healthUrl, HEALTH_TIMEOUT_MS);
        probeLatencies.push(latencyMs);
        processingSnapshots.push(body.pool.processingCount ?? 0);
        expect(response.status).toBe(200);
        expect(latencyMs).toBeLessThan(HEALTH_TIMEOUT_MS);

        const remainingSleepMs = PROBE_INTERVAL_MS - (Date.now() - probeStartedAt);
        if (remainingSleepMs > 0) {
          await delay(remainingSleepMs);
        }
      }
    })();

    const loadStartedAt = Date.now();
    pool.start();

    try {
      await waitFor(
        () => proxy!.getMetrics().totalRequests >= EXPECTED_REQUESTS,
        DRAIN_TIMEOUT_MS,
        `Expected ${EXPECTED_REQUESTS} OpenRouter requests to be issued, saw ${proxy!.getMetrics().totalRequests}`
      );
      const senderPhaseDurationMs = Date.now() - loadStartedAt;
      const senderMetrics = proxy.getMetrics();

      await waitFor(
        () => pendingStore.getPendingCount(sessionDbId) === 0
          && storageCoordinator!.getStatus().persistQueueDepth === 0
          && storageCoordinator!.getStatus().inflightPersists === 0,
        DRAIN_TIMEOUT_MS,
        'Persist backlog did not drain to zero'
      );

      stopProbing = true;
      await probeLoop;

      const highInFlightSamples = senderMetrics.inFlightSamples.filter((value) => value >= POOL_CONCURRENCY - 2);
      const baselineSequentialMs = MESSAGE_COUNT * PROVIDER_DELAY_MS * 2;
      const recvQueueP95 = computeP95(senderMetrics.recvQueueSamples);

      expect(probeLatencies.length).toBeGreaterThanOrEqual(10);
      expect(processingSnapshots.some((count) => count >= 1)).toBe(true);
      expect(senderMetrics.maxInFlight).toBeGreaterThanOrEqual(POOL_CONCURRENCY - 1);
      expect(highInFlightSamples.length / Math.max(1, senderMetrics.inFlightSamples.length)).toBeGreaterThanOrEqual(0.8);
      expect(senderPhaseDurationMs).toBeLessThan(baselineSequentialMs / 3);

      if (senderMetrics.recvQueueSamples.length > 0) {
        expect(recvQueueP95).toBe(0);
        expect(Math.max(...senderMetrics.recvQueueSamples)).toBeLessThanOrEqual(1);
      }

      expect(pendingStore.getPendingCount(sessionDbId)).toBe(0);
    } finally {
      stopProbing = true;
      await probeLoop.catch(() => {});
    }
  }, 30_000);
});
