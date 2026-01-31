/**
 * SessionCleanupHelper: Session state cleanup after response processing
 *
 * Responsibility:
 * - Reset earliest pending timestamp
 * - Broadcast processing status updates
 *
 * NOTE: With two-phase commit queue pattern, messages are marked 'processing' on claim
 * and completed by SessionQueueProcessor after successful processing.
 */

import type { ActiveSession } from '../../worker-types.js';
import type { WorkerRef } from './types.js';

/**
 * Clean up session state after response processing
 *
 * With two-phase commit queue pattern, this function:
 * 1. Resets the earliest pending timestamp
 * 2. Broadcasts updated processing status to SSE clients
 *
 * @param session - Active session to clean up
 * @param worker - Worker reference for status broadcasting (optional)
 */
export function cleanupProcessedMessages(
  session: ActiveSession,
  worker: WorkerRef | undefined
): void {
  // Reset earliest pending timestamp for next batch
  session.earliestPendingTimestamp = null;

  // Broadcast activity status after processing (queue may have changed)
  if (worker && typeof worker.broadcastProcessingStatus === 'function') {
    worker.broadcastProcessingStatus();
  }
}
