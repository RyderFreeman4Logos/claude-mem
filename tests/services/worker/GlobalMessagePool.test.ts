import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
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
});
