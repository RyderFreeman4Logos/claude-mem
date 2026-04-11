import { logger } from '../../utils/logger.js';
import type { PersistentPendingMessage, PendingMessageStore } from '../sqlite/PendingMessageStore.js';
import { ConcurrencyManager } from './ConcurrencyManager.js';

const IDLE_POLL_MS = 1000;

type MessageProcessor = (message: PersistentPendingMessage) => Promise<void>;

interface WorkerHandle {
  id: number;
  promise: Promise<void>;
}

export class GlobalMessagePool {
  private running = false;
  private nextWorkerId = 1;
  private workers = new Map<number, WorkerHandle>();
  private retiringWorkers = new Set<number>();
  private waiters = new Set<() => void>();
  private unsubscribeFromChanges: (() => void) | null = null;

  constructor(
    private pendingStore: PendingMessageStore,
    private concurrencyManager: ConcurrencyManager,
    private processMessage: MessageProcessor
  ) {}

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
    });

    this.workers.set(workerId, { id: workerId, promise });
  }

  private async workerLoop(workerId: number): Promise<void> {
    while (this.running) {
      if (this.retiringWorkers.has(workerId)) {
        return;
      }

      const message = this.pendingStore.claimNextMessage();

      if (!message) {
        await this.waitForWork();
        continue;
      }

      const sessionDbId = message.session_db_id;

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
        this.notify();
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
}
