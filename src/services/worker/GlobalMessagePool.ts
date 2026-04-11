import { logger } from '../../utils/logger.js';
import type { PersistentPendingMessage, PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { ConcurrencyManager } from './ConcurrencyManager.js';
import type { AsyncSemaphore } from './AsyncSemaphore.js';

const IDLE_POLL_MS = 1000;

type MessageProcessor = (message: PersistentPendingMessage) => Promise<void>;
type ClaimGate = () => Promise<void>;

interface WorkerHandle {
  id: number;
  promise: Promise<void>;
}

export interface GlobalMessagePoolStatus {
  running: boolean;
  desiredConcurrency: number;
  poolSize: number;
  activeWorkers: number;
  processingCount: number;
  retiringWorkers: number;
  lastTickMs: number | null;
  lastClaimMs: number | null;
  lastCompletionMs: number | null;
  lastYieldMs: number | null;
}

export class GlobalMessagePool {
  private running = false;
  private nextWorkerId = 1;
  private workers = new Map<number, WorkerHandle>();
  private retiringWorkers = new Set<number>();
  private waiters = new Set<() => void>();
  private unsubscribeFromChanges: (() => void) | null = null;
  private activeWorkerIds = new Set<number>();
  private processingWorkerIds = new Set<number>();
  private lastTickMs: number | null = null;
  private lastClaimMs: number | null = null;
  private lastCompletionMs: number | null = null;
  private lastYieldMs: number | null = null;

  constructor(
    private pendingStore: PendingMessageStore,
    private concurrencyManager: ConcurrencyManager,
    private processMessage: MessageProcessor,
    private beforeClaim?: ClaimGate,
    private sqliteGate?: AsyncSemaphore
  ) {}

  getStatus(): GlobalMessagePoolStatus {
    return {
      running: this.running,
      desiredConcurrency: this.concurrencyManager.getDesiredConcurrency(),
      poolSize: this.workers.size,
      activeWorkers: this.activeWorkerIds.size,
      processingCount: this.processingWorkerIds.size,
      retiringWorkers: this.retiringWorkers.size,
      lastTickMs: this.lastTickMs,
      lastClaimMs: this.lastClaimMs,
      lastCompletionMs: this.lastCompletionMs,
      lastYieldMs: this.lastYieldMs
    };
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.concurrencyManager.startWatching();
    this.unsubscribeFromChanges = this.concurrencyManager.subscribeToChanges((nextConcurrency) => {
      logger.info('SYSTEM', 'Reconciling global message pool size', {
        desiredConcurrency: nextConcurrency
      });
      this.reconcileWorkerCount();
      this.notify();
    });

    this.reconcileWorkerCount();
    this.notify();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.unsubscribeFromChanges?.();
    this.unsubscribeFromChanges = null;
    this.concurrencyManager.stopWatching();

    for (const workerId of this.workers.keys()) {
      this.retiringWorkers.add(workerId);
    }

    this.notify();

    const workerPromises = Array.from(this.workers.values(), (worker) => worker.promise);
    await Promise.allSettled(workerPromises);

    this.workers.clear();
    this.retiringWorkers.clear();
  }

  notify(): void {
    const waiters = Array.from(this.waiters);
    this.waiters.clear();
    for (const wake of waiters) {
      wake();
    }
  }

  private reconcileWorkerCount(): void {
    if (!this.running) {
      return;
    }

    const desiredConcurrency = this.concurrencyManager.getDesiredConcurrency();
    const currentCount = this.workers.size;

    if (currentCount < desiredConcurrency) {
      for (let i = currentCount; i < desiredConcurrency; i += 1) {
        this.spawnWorker();
      }
      return;
    }

    if (currentCount > desiredConcurrency) {
      const workerIds = Array.from(this.workers.keys()).sort((left, right) => right - left);
      const toRetire = currentCount - desiredConcurrency;
      for (const workerId of workerIds.slice(0, toRetire)) {
        this.retiringWorkers.add(workerId);
      }
    }
  }

  private spawnWorker(): void {
    const workerId = this.nextWorkerId;
    this.nextWorkerId += 1;

    const promise = this.workerLoop(workerId).finally(() => {
      this.workers.delete(workerId);
      this.retiringWorkers.delete(workerId);
      this.activeWorkerIds.delete(workerId);
      this.processingWorkerIds.delete(workerId);
      this.touch();
    });

    this.workers.set(workerId, { id: workerId, promise });
    this.touch();
  }

  private async workerLoop(workerId: number): Promise<void> {
    while (this.running) {
      if (this.retiringWorkers.has(workerId)) {
        return;
      }

      this.activeWorkerIds.add(workerId);
      this.touch();

      try {
        await this.beforeClaim?.();
      } catch (error) {
        logger.error('QUEUE', 'Global message worker failed before claim', {
          workerId
        }, error as Error);
        this.activeWorkerIds.delete(workerId);
        this.touch();
        await this.waitForWork();
        continue;
      }

      const message = await this.claimNextMessage(workerId);

      if (!message) {
        this.activeWorkerIds.delete(workerId);
        this.touch();
        await this.waitForWork();
        continue;
      }

      // A claimed message must be finished or explicitly failed before the worker
      // can honor retire/stop signals; otherwise the row stays stuck in processing.
      const sessionDbId = message.session_db_id;
      this.processingWorkerIds.add(workerId);
      this.lastClaimMs = Date.now();
      this.touch(this.lastClaimMs);

      try {
        await this.processMessage(message);

        if (this.pendingStore.getMessageStatus(message.id) === 'processing') {
          logger.warn('QUEUE', 'Message returned without confirmation, re-queueing with backoff', {
            workerId,
            sessionDbId,
            messageId: message.id,
            type: message.message_type
          });
          this.pendingStore.markFailed(message.id);
        }
      } catch (error) {
        logger.error('QUEUE', 'Global message worker failed', {
          workerId,
          sessionDbId,
          messageId: message.id,
          type: message.message_type
        }, error as Error);

        if (this.pendingStore.getMessageStatus(message.id) === 'processing') {
          this.pendingStore.markFailed(message.id);
        }
      } finally {
        this.processingWorkerIds.delete(workerId);
        this.lastCompletionMs = Date.now();
        this.touch(this.lastCompletionMs);
        this.notify();
        await this.yieldToEventLoop();
      }
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.waiters.delete(onWake);
        resolve();
      }, IDLE_POLL_MS);

      const onWake = () => {
        clearTimeout(timeoutId);
        resolve();
      };

      this.waiters.add(onWake);
    });
  }

  private async claimNextMessage(workerId: number): Promise<PersistentPendingMessage | null> {
    if (!this.sqliteGate) {
      return this.pendingStore.claimNextMessage();
    }

    return this.sqliteGate.run('claim', () => {
      if (!this.running || this.retiringWorkers.has(workerId)) {
        return null;
      }

      return this.pendingStore.claimNextMessage();
    });
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    this.lastYieldMs = Date.now();
    this.touch(this.lastYieldMs);
  }

  private touch(timestamp: number = Date.now()): void {
    this.lastTickMs = timestamp;
  }
}
