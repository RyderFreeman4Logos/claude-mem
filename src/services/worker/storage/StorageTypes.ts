import type { ParsedObservation } from '../../../sdk/parser.js';
import type { PersistentPendingMessage } from '../../sqlite/PendingMessageStore.js';

export interface PersistedSummaryPayload {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}

export interface PersistResponseJob {
  sessionDbId: number;
  contentSessionId: string;
  memorySessionId: string;
  project: string;
  platformSource: string;
  lastPromptNumber: number;
  discoveryTokens: number;
  originalTimestamp: number | null;
  modelId?: string;
  processingMessageIds: number[];
  observations: ParsedObservation[];
  summary: PersistedSummaryPayload | null;
}

export interface StorageCommitResult {
  observationIds: number[];
  summaryId: number | null;
  createdAtEpoch: number;
}

export interface StorageCoordinatorStatus {
  claimQueueDepth: number;
  persistQueueDepth: number;
  inflightPersists: number;
}

export interface StorageCoordinator {
  start(): Promise<void>;
  claimNextMessage(sessionDbId?: number): Promise<PersistentPendingMessage | null>;
  enqueuePersist(job: PersistResponseJob): Promise<StorageCommitResult>;
  markFailed(messageIds: number[]): Promise<void>;
  getStatus(): StorageCoordinatorStatus;
  shutdown(): Promise<void>;
}

export interface StorageWorkerOptions {
  commitDelayMs?: number;
}

export interface StorageWorkerData {
  dbPath: string;
  options?: StorageWorkerOptions;
}

export interface StorageWorkerRequestMap {
  claim: { sessionDbId?: number };
  persist: { job: PersistResponseJob };
  markFailed: { messageIds: number[] };
  shutdown: Record<string, never>;
}

export interface StorageWorkerResponseMap {
  claim: PersistentPendingMessage | null;
  persist: StorageCommitResult;
  markFailed: null;
  shutdown: null;
}

export type StorageWorkerRequestType = keyof StorageWorkerRequestMap;

export interface StorageWorkerRequest<T extends StorageWorkerRequestType = StorageWorkerRequestType> {
  requestId: number;
  type: T;
  payload: StorageWorkerRequestMap[T];
}

export interface StorageWorkerSuccessResponse<T extends StorageWorkerRequestType = StorageWorkerRequestType> {
  requestId: number;
  ok: true;
  type: T;
  result: StorageWorkerResponseMap[T];
}

export interface StorageWorkerErrorResponse<T extends StorageWorkerRequestType = StorageWorkerRequestType> {
  requestId: number;
  ok: false;
  type: T;
  error: {
    message: string;
    stack?: string;
  };
}

export type StorageWorkerResponse<T extends StorageWorkerRequestType = StorageWorkerRequestType> =
  | StorageWorkerSuccessResponse<T>
  | StorageWorkerErrorResponse<T>;
