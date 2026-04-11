import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { WorkerService } from '../../../src/services/worker-service.js';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';
import { GlobalMessagePool } from '../../../src/services/worker/GlobalMessagePool.js';
import type { ConcurrencyManager } from '../../../src/services/worker/ConcurrencyManager.js';

function createConcurrencyManagerStub(desiredConcurrency: number): ConcurrencyManager {
  return {
    startWatching: () => {},
    stopWatching: () => {},
    subscribeToChanges: () => () => {},
    getDesiredConcurrency: () => desiredConcurrency
  } as unknown as ConcurrencyManager;
}

function createMutableConcurrencyManagerStub(initialDesiredConcurrency: number): {
  manager: ConcurrencyManager;
  setDesiredConcurrency: (nextConcurrency: number) => void;
} {
  let desiredConcurrency = initialDesiredConcurrency;
  let onChange: ((nextConcurrency: number) => void) | null = null;

  return {
    manager: {
      startWatching: () => {},
      stopWatching: () => {},
      subscribeToChanges: (callback: (nextConcurrency: number) => void) => {
        onChange = callback;
        return () => {
          if (onChange === callback) {
            onChange = null;
          }
        };
      },
      getDesiredConcurrency: () => desiredConcurrency
    } as unknown as ConcurrencyManager,
    setDesiredConcurrency: (nextConcurrency: number) => {
      desiredConcurrency = nextConcurrency;
      onChange?.(nextConcurrency);
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('GlobalMessagePool', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const contentSessionId = 'global-message-pool-test';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, contentSessionId, 'test-project', 'Test prompt');
  });

  afterEach(() => {
    db.close();
  });

  function enqueueMessage(overrides: Partial<PendingMessage> = {}): number {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
      ...overrides
    };
    return store.enqueue(sessionDbId, contentSessionId, message);
  }

  test('processes messages from the same session up to the worker concurrency limit', async () => {
    const messageIds = Array.from({ length: 10 }, (_, index) => enqueueMessage({
      prompt_number: index + 1,
      tool_input: { index },
      tool_response: { index }
    }));

    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    const startedIds: number[] = [];
    const completedIds: number[] = [];

    let releaseWorkers!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });

    const pool = new GlobalMessagePool(
      store,
      createConcurrencyManagerStub(5),
      async (message) => {
        startedIds.push(message.id);
        activeWorkers += 1;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);

        await releasePromise;

        store.confirmProcessed(message.id);
        completedIds.push(message.id);
        activeWorkers -= 1;
      }
    );

    pool.start();

    try {
      await waitFor(() => startedIds.length === 5);
      expect(maxActiveWorkers).toBe(5);
      expect(new Set(startedIds).size).toBe(5);

      releaseWorkers();

      await waitFor(() => completedIds.length === 10);
      expect(new Set(completedIds)).toEqual(new Set(messageIds));
    } finally {
      releaseWorkers();
      await pool.stop();
    }
  });

  test('reports pool status while workers are active and records a yield timestamp', async () => {
    enqueueMessage({ prompt_number: 1 });

    let releaseWorker!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });

    const pool = new GlobalMessagePool(
      store,
      createConcurrencyManagerStub(1),
      async (message) => {
        await releasePromise;
        store.confirmProcessed(message.id);
      }
    );

    pool.start();

    try {
      await waitFor(() => pool.getStatus().processingCount === 1);

      const activeStatus = pool.getStatus();
      expect(activeStatus.running).toBe(true);
      expect(activeStatus.desiredConcurrency).toBe(1);
      expect(activeStatus.poolSize).toBe(1);
      expect(activeStatus.activeWorkers).toBe(1);
      expect(activeStatus.processingCount).toBe(1);
      expect(activeStatus.lastTickMs).not.toBeNull();
      expect(activeStatus.lastClaimMs).not.toBeNull();

      releaseWorker();

      await waitFor(() => pool.getStatus().lastYieldMs !== null);

      const completedStatus = pool.getStatus();
      expect(completedStatus.processingCount).toBe(0);
      expect(completedStatus.lastCompletionMs).not.toBeNull();
      expect(completedStatus.lastYieldMs).not.toBeNull();
    } finally {
      releaseWorker();
      await pool.stop();
    }
  });

  test('keeps summarize work blocked until earlier observations finish', async () => {
    const observationIds = [
      enqueueMessage({ prompt_number: 1 }),
      enqueueMessage({ prompt_number: 2 }),
      enqueueMessage({ prompt_number: 3 })
    ];
    const summarizeId = enqueueMessage({
      type: 'summarize',
      tool_name: undefined,
      tool_input: undefined,
      tool_response: undefined,
      last_assistant_message: 'done'
    });

    const startedTypes: string[] = [];
    let summarizeStarted = false;

    let releaseObservations!: () => void;
    const observationRelease = new Promise<void>((resolve) => {
      releaseObservations = resolve;
    });

    const pool = new GlobalMessagePool(
      store,
      createConcurrencyManagerStub(4),
      async (message) => {
        startedTypes.push(message.message_type);

        if (message.message_type === 'summarize') {
          summarizeStarted = true;
          store.confirmProcessed(message.id);
          return;
        }

        await observationRelease;
        store.confirmProcessed(message.id);
      }
    );

    pool.start();

    try {
      await waitFor(() => observationIds.every((id) => startedTypes.length >= 3 && store.getMessageStatus(id) === 'processing'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(summarizeStarted).toBe(false);

      releaseObservations();

      await waitFor(() => summarizeStarted);
      expect(startedTypes.at(-1)).toBe('summarize');
      expect(store.getMessageStatus(summarizeId)).toBeNull();
    } finally {
      releaseObservations();
      await pool.stop();
    }
  });

  test('requeues only the failed claimed message when same-session work is already processing', async () => {
    const firstMessageId = enqueueMessage({ prompt_number: 1 });
    const secondMessageId = enqueueMessage({ prompt_number: 2 });

    const firstClaim = store.claimNextMessage();
    const secondClaim = store.claimNextMessage();

    expect(firstClaim?.id).toBe(firstMessageId);
    expect(secondClaim?.id).toBe(secondMessageId);

    let secondStarted = false;
    let releaseSecond!: () => void;
    const releaseSecondPromise = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const fakeAgent = {
      startSession: async (session: any) => {
        const claimedMessage = session.preclaimedMessages[0];
        session.processingMessageIds.push(claimedMessage._persistentId);

        if (claimedMessage._persistentId === firstMessageId) {
          await waitFor(() => secondStarted);
          throw new Error('first claimed message failed');
        }

        secondStarted = true;
        await releaseSecondPromise;
        store.confirmProcessed(claimedMessage._persistentId);
        session.processingMessageIds = [];
      }
    };

    const fakeService = {
      sdkAgent: {},
      sessionManager: {
        getPendingMessageStore: () => store,
        removeSessionImmediate: () => {}
      },
      createIsolatedClaimedSession: (message: NonNullable<typeof firstClaim>) => ({
        sessionDbId: message.session_db_id,
        contentSessionId,
        memorySessionId: null,
        project: 'test-project',
        platformSource: 'claude',
        userPrompt: 'Test prompt',
        pendingMessages: [],
        abortController: new AbortController(),
        generatorPromise: null,
        lastPromptNumber: message.prompt_number ?? 1,
        startTime: Date.now(),
        cumulativeInputTokens: 0,
        cumulativeOutputTokens: 0,
        earliestPendingTimestamp: null,
        conversationHistory: [],
        currentProvider: null,
        consecutiveRestarts: 0,
        processingMessageIds: [],
        preclaimedMessages: [store.toPendingMessageWithId(message)],
        claimAdditionalMessagesFromStore: false,
        lastGeneratorActivity: Date.now()
      }),
      getActiveAgent: () => fakeAgent,
      applyTierRouting: () => {},
      broadcastProcessingStatus: () => {},
      lastAiInteraction: null
    };

    const firstRun = (WorkerService.prototype as any)
      .processClaimedSessionMessage
      .call(fakeService, firstClaim)
      .then(
        () => ({ ok: true }),
        (error: Error) => ({ ok: false, error })
      );
    const secondRun = (WorkerService.prototype as any)
      .processClaimedSessionMessage
      .call(fakeService, secondClaim)
      .then(() => ({ ok: true }));

    try {
      await waitFor(() => secondStarted);
      await waitFor(() => store.getMessageStatus(firstMessageId) === 'pending');

      expect(store.getMessageStatus(secondMessageId)).toBe('processing');

      releaseSecond();

      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
      expect(firstResult.ok).toBe(false);
      expect(firstResult.error?.message).toContain('failed');
      expect(secondResult.ok).toBe(true);
      expect(store.getMessageStatus(secondMessageId)).toBeNull();
    } finally {
      releaseSecond();
    }
  });

  test('waits for the claim gate before marking SDK work as processing', async () => {
    const messageId = enqueueMessage({ prompt_number: 1 });

    let allowClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      allowClaim = resolve;
    });
    let started = false;

    const pool = new GlobalMessagePool(
      store,
      createConcurrencyManagerStub(1),
      async (message) => {
        started = true;
        store.confirmProcessed(message.id);
      },
      async () => claimGate
    );

    pool.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started).toBe(false);
      expect(store.getMessageStatus(messageId)).toBe('pending');

      allowClaim();

      await waitFor(() => started);
      expect(store.getMessageStatus(messageId)).toBeNull();
    } finally {
      allowClaim();
      await pool.stop();
    }
  });

  test('retires excess workers after in-flight messages finish when concurrency shrinks', async () => {
    const concurrency = createMutableConcurrencyManagerStub(3);
    const pendingCountSpy = spyOn(store, 'getTotalPendingCount');
    const firstWaveIds = Array.from({ length: 3 }, (_, index) => enqueueMessage({ prompt_number: index + 1 }));

    let firstWaveActive = 0;
    let secondWaveActive = 0;
    let secondWaveMaxActive = 0;
    const completedIds: number[] = [];

    let releaseFirstWave!: () => void;
    const firstWaveRelease = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const secondWaveIdSet = new Set<number>();

    const pool = new GlobalMessagePool(
      store,
      concurrency.manager,
      async (message) => {
        if (!secondWaveIdSet.has(message.id)) {
          firstWaveActive += 1;
          await firstWaveRelease;
          firstWaveActive -= 1;
        } else {
          secondWaveActive += 1;
          secondWaveMaxActive = Math.max(secondWaveMaxActive, secondWaveActive);
          await new Promise((resolve) => setTimeout(resolve, 50));
          secondWaveActive -= 1;
        }

        store.confirmProcessed(message.id);
        completedIds.push(message.id);
      }
    );

    pool.start();

    try {
      await waitFor(() => firstWaveIds.every((id) => store.getMessageStatus(id) === 'processing'));
      expect(firstWaveActive).toBe(3);

      concurrency.setDesiredConcurrency(1);
      releaseFirstWave();

      await waitFor(() => completedIds.length === 3);

      const secondWaveIds = Array.from({ length: 3 }, (_, index) => enqueueMessage({ prompt_number: index + 4 }));
      for (const messageId of secondWaveIds) {
        secondWaveIdSet.add(messageId);
      }
      pool.notify();

      await waitFor(() => completedIds.length === 6);

      expect(secondWaveMaxActive).toBe(1);
      expect(new Set(completedIds)).toEqual(new Set([...firstWaveIds, ...secondWaveIds]));
      expect(pendingCountSpy).not.toHaveBeenCalled();
    } finally {
      pendingCountSpy.mockRestore();
      releaseFirstWave();
      await pool.stop();
    }
  });

  test('runs summarize after later same-session observations when summarize is queued in the middle', async () => {
    const observationIds = [
      enqueueMessage({ prompt_number: 1 }),
      enqueueMessage({ prompt_number: 2 })
    ];
    const summarizeId = enqueueMessage({
      type: 'summarize',
      tool_name: undefined,
      tool_input: undefined,
      tool_response: undefined,
      last_assistant_message: 'done'
    });
    const trailingObservationId = enqueueMessage({ prompt_number: 3 });

    const startedIds: number[] = [];
    let summarizeStarted = false;

    let releaseObservations!: () => void;
    const observationRelease = new Promise<void>((resolve) => {
      releaseObservations = resolve;
    });

    const pool = new GlobalMessagePool(
      store,
      createConcurrencyManagerStub(3),
      async (message) => {
        startedIds.push(message.id);

        if (message.message_type === 'summarize') {
          summarizeStarted = true;
          store.confirmProcessed(message.id);
          return;
        }

        await observationRelease;
        store.confirmProcessed(message.id);
      }
    );

    pool.start();

    try {
      await waitFor(() => startedIds.length === 3);
      expect(startedIds).toEqual([...observationIds, trailingObservationId]);
      expect(startedIds).not.toContain(summarizeId);

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(summarizeStarted).toBe(false);

      releaseObservations();

      await waitFor(() => summarizeStarted);
      expect(startedIds.at(-1)).toBe(summarizeId);
      expect(store.getMessageStatus(summarizeId)).toBeNull();
    } finally {
      releaseObservations();
      await pool.stop();
    }
  });
});
