import { parentPort, workerData } from 'worker_threads';
import { SessionStore } from '../../sqlite/SessionStore.js';
import { PendingMessageStore } from '../../sqlite/PendingMessageStore.js';
import type {
  StorageWorkerData,
  StorageWorkerErrorResponse,
  StorageWorkerRequest,
  StorageWorkerRequestMap,
  StorageWorkerRequestType,
  StorageWorkerResponseMap,
  StorageWorkerSuccessResponse,
} from './StorageTypes.js';

const data = workerData as StorageWorkerData;

const port = parentPort;

if (!port) {
  throw new Error('Sqlite writer worker requires a parentPort');
}

const sessionStore = new SessionStore(data.dbPath);
const pendingStore = new PendingMessageStore(sessionStore.db, 3);

function blockFor(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }

  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function runRequest<T extends StorageWorkerRequestType>(request: StorageWorkerRequest<T>): StorageWorkerResponseMap[T] {
  switch (request.type) {
    case 'claim': {
      const { sessionDbId } = request.payload as StorageWorkerRequestMap['claim'];
      return pendingStore.claimNextMessage(sessionDbId) as StorageWorkerResponseMap[T];
    }
    case 'persist': {
      const { job } = request.payload as StorageWorkerRequestMap['persist'];

      sessionStore.ensureMemorySessionIdRegistered(job.sessionDbId, job.memorySessionId);
      blockFor(data.options?.commitDelayMs ?? 0);

      const result = sessionStore.storeObservations(
        job.memorySessionId,
        job.project,
        job.observations,
        job.summary,
        job.lastPromptNumber,
        job.discoveryTokens,
        job.originalTimestamp ?? undefined,
        job.modelId
      );

      for (const messageId of job.processingMessageIds) {
        pendingStore.confirmProcessed(messageId);
      }

      return result as StorageWorkerResponseMap[T];
    }
    case 'markFailed': {
      const { messageIds } = request.payload as StorageWorkerRequestMap['markFailed'];
      for (const messageId of messageIds) {
        pendingStore.markFailed(messageId);
      }
      return null as StorageWorkerResponseMap[T];
    }
    case 'shutdown':
      sessionStore.close();
      return null as StorageWorkerResponseMap[T];
    default: {
      const exhaustive: never = request.type;
      throw new Error(`Unsupported sqlite writer request: ${String(exhaustive)}`);
    }
  }
}

port.on('message', (request: StorageWorkerRequest) => {
  try {
    const result = runRequest(request as never);
    const response: StorageWorkerSuccessResponse = {
      requestId: request.requestId,
      ok: true,
      type: request.type,
      result
    };
    port.postMessage(response);
  } catch (error) {
    if (request.type === 'persist') {
      const { messageIds } = { messageIds: (request.payload as StorageWorkerRequestMap['persist']).job.processingMessageIds };
      for (const messageId of messageIds) {
        pendingStore.markFailed(messageId);
      }
    }

    const typedError = error instanceof Error ? error : new Error(String(error));
    const response: StorageWorkerErrorResponse = {
      requestId: request.requestId,
      ok: false,
      type: request.type,
      error: {
        message: typedError.message,
        stack: typedError.stack
      }
    };
    port.postMessage(response);
  }
});
