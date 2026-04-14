import { Worker } from 'worker_threads';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../../utils/logger.js';
import type { PersistentPendingMessage } from '../../sqlite/PendingMessageStore.js';
import type {
  PersistResponseJob,
  StorageCommitResult,
  StorageCoordinator,
  StorageCoordinatorStatus,
  StorageWorkerData,
  StorageWorkerErrorResponse,
  StorageWorkerRequest,
  StorageWorkerRequestMap,
  StorageWorkerRequestType,
  StorageWorkerResponse,
  StorageWorkerResponseMap,
  StorageWorkerSuccessResponse,
  StorageWorkerOptions,
} from './StorageTypes.js';

interface PendingRequest<T extends StorageWorkerRequestType = StorageWorkerRequestType> {
  type: T;
  resolve: (value: StorageWorkerResponseMap[StorageWorkerRequestType]) => void;
  reject: (reason?: unknown) => void;
}

interface QueuedRequest<T extends StorageWorkerRequestType = StorageWorkerRequestType> {
  requestId: number;
  type: T;
  payload: StorageWorkerRequestMap[T];
}

function resolveWriterWorkerPath(): string {
  if (typeof __dirname !== 'undefined' && typeof __filename !== 'undefined' && __filename.endsWith('.cjs')) {
    return join(__dirname, 'sqlite-writer-worker.cjs');
  }

  return fileURLToPath(new URL('./sqlite-writer-entry.ts', import.meta.url));
}

class StorageWorkerChannel {
  private worker: Worker | null = null;
  private readonly queue: QueuedRequest[] = [];
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private activeRequestId: number | null = null;
  private nextRequestId = 1;
  private started = false;
  private stopping = false;

  constructor(
    private readonly label: string,
    private readonly dbPath: string,
    private readonly options: StorageWorkerOptions
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const workerData: StorageWorkerData = {
      dbPath: this.dbPath,
      options: this.options
    };

    this.worker = new Worker(resolveWriterWorkerPath(), { workerData });
    this.worker.on('message', (response: StorageWorkerResponse) => {
      this.handleWorkerMessage(response);
    });
    this.worker.on('error', (error) => {
      logger.error('DB', `${this.label} worker failed`, { dbPath: this.dbPath }, error);
      this.failAllPending(error);
    });
    this.worker.on('exit', (code) => {
      const wasStopping = this.stopping;
      this.worker = null;
      this.started = false;
      this.activeRequestId = null;

      if (!wasStopping && code !== 0) {
        this.failAllPending(new Error(`${this.label} worker exited with code ${code}`));
      }
    });

    this.started = true;
    this.stopping = false;
  }

  request<T extends StorageWorkerRequestType>(
    type: T,
    payload: StorageWorkerRequestMap[T]
  ): Promise<StorageWorkerResponseMap[T]> {
    if (!this.started || !this.worker || (this.stopping && type !== 'shutdown')) {
      throw new Error(`${this.label} worker is not running`);
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    const request: QueuedRequest<T> = { requestId, type, payload };

    return new Promise<StorageWorkerResponseMap[T]>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        type,
        resolve: resolve as (value: StorageWorkerResponseMap[StorageWorkerRequestType]) => void,
        reject
      });
      this.queue.push(request);
      this.pumpQueue();
    });
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  getActiveType(): StorageWorkerRequestType | null {
    if (this.activeRequestId === null) {
      return null;
    }
    return this.pendingRequests.get(this.activeRequestId)?.type ?? null;
  }

  async shutdown(): Promise<void> {
    if (!this.started || !this.worker) {
      this.started = false;
      this.stopping = false;
      return;
    }

    try {
      this.stopping = true;
      await this.request('shutdown', {});
    } catch (error) {
      logger.warn('DB', `${this.label} worker shutdown request failed`, { dbPath: this.dbPath }, error as Error);
    }

    const worker = this.worker;
    this.worker = null;
    this.started = false;

    if (worker) {
      try {
        await worker.terminate();
      } catch (error) {
        logger.warn('DB', `${this.label} worker termination failed`, { dbPath: this.dbPath }, error as Error);
      }
    }

    this.failAllPending(new Error(`${this.label} worker stopped`));
    this.stopping = false;
  }

  private pumpQueue(): void {
    if (!this.worker || this.activeRequestId !== null) {
      return;
    }

    const nextRequest = this.queue.shift();
    if (!nextRequest) {
      return;
    }

    this.activeRequestId = nextRequest.requestId;
    const message: StorageWorkerRequest = {
      requestId: nextRequest.requestId,
      type: nextRequest.type,
      payload: nextRequest.payload as StorageWorkerRequestMap[StorageWorkerRequestType]
    };
    this.worker.postMessage(message);
  }

  private handleWorkerMessage(response: StorageWorkerResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.requestId);
    if (this.activeRequestId === response.requestId) {
      this.activeRequestId = null;
    }

    if (response.ok) {
      pending.resolve((response as StorageWorkerSuccessResponse).result);
    } else {
      const errorResponse = response as StorageWorkerErrorResponse;
      const error = new Error(errorResponse.error.message);
      error.stack = errorResponse.error.stack;
      pending.reject(error);
    }

    this.pumpQueue();
  }

  private failAllPending(error: Error): void {
    for (const queued of this.queue) {
      const pending = this.pendingRequests.get(queued.requestId);
      if (!pending) {
        continue;
      }
      pending.reject(error);
      this.pendingRequests.delete(queued.requestId);
    }

    if (this.activeRequestId !== null) {
      const pending = this.pendingRequests.get(this.activeRequestId);
      if (pending) {
        pending.reject(error);
        this.pendingRequests.delete(this.activeRequestId);
      }
    }

    this.queue.length = 0;
    this.activeRequestId = null;
  }
}

export class SqliteWriter implements StorageCoordinator {
  private readonly claimChannel: StorageWorkerChannel;
  private readonly persistChannel: StorageWorkerChannel;

  constructor(
    private readonly dbPath: string,
    private readonly options: StorageWorkerOptions = {}
  ) {
    this.claimChannel = new StorageWorkerChannel('SqliteClaimWriter', dbPath, options);
    this.persistChannel = new StorageWorkerChannel('SqlitePersistWriter', dbPath, options);
  }

  async start(): Promise<void> {
    await this.claimChannel.start();
    await this.persistChannel.start();
  }

  claimNextMessage(sessionDbId?: number): Promise<PersistentPendingMessage | null> {
    return this.claimChannel.request('claim', sessionDbId === undefined ? {} : { sessionDbId });
  }

  enqueuePersist(job: PersistResponseJob): Promise<StorageCommitResult> {
    return this.persistChannel.request('persist', { job });
  }

  markFailed(messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return Promise.resolve();
    }

    return this.claimChannel.request('markFailed', { messageIds }).then(() => undefined);
  }

  getStatus(): StorageCoordinatorStatus {
    return {
      claimQueueDepth: this.claimChannel.getQueueDepth(),
      persistQueueDepth: this.persistChannel.getQueueDepth(),
      inflightPersists: this.persistChannel.getActiveType() === 'persist' ? 1 : 0
    };
  }

  async shutdown(): Promise<void> {
    await this.claimChannel.shutdown();
    await this.persistChannel.shutdown();
  }
}
