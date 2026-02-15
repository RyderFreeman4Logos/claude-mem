import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

const IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

export interface CreateIteratorOptions {
  sessionDbId: number;
  signal: AbortSignal;
  /** Called when idle timeout occurs - should trigger abort to kill subprocess */
  onIdleTimeout?: () => void;
}

export class SessionQueueProcessor {
  constructor(
    private store: PendingMessageStore,
    private events: EventEmitter
  ) {}

  /**
   * Create an async iterator that yields messages as they become available.
   * Uses two-phase commit pattern for crash-safe message processing:
   * 1. claim(): Mark message as 'processing' (message stays in DB)
   * 2. complete(): Delete message after successful processing
   *
   * If Worker crashes during processing, message remains in 'processing' state
   * and will be reset to 'pending' on next Worker startup.
   *
   * CRITICAL: Calls onIdleTimeout callback after 3 minutes of inactivity.
   * The callback should trigger abortController.abort() to kill the subprocess.
   * Just returning from the iterator is NOT enough - the subprocess stays alive.
   */
  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const { sessionDbId, signal, onIdleTimeout } = options;
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      try {
        // Atomically claim next message (status -> 'processing')
        const persistentMessage = this.store.claimAndDelete(sessionDbId);

        if (persistentMessage) {
          // Reset activity time when we successfully yield a message
          lastActivityTime = Date.now();
          // Yield the message for processing (it's still in DB as 'processing')
          yield this.toPendingMessageWithId(persistentMessage);
        } else {
          // Queue empty - wait for wake-up event or timeout
          const receivedMessage = await this.waitForMessage(signal, IDLE_TIMEOUT_MS);

          if (!receivedMessage && !signal.aborted) {
            const idleDuration = Date.now() - lastActivityTime;
            if (idleDuration >= IDLE_TIMEOUT_MS) {
              logger.info('SESSION', 'Idle timeout reached, triggering abort to kill subprocess', {
                sessionDbId,
                idleDurationMs: idleDuration,
                thresholdMs: IDLE_TIMEOUT_MS
              });
              onIdleTimeout?.();
              return;
            }
            // Reset timer on spurious wakeup
            lastActivityTime = Date.now();
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        logger.error('SESSION', 'Error in queue processor loop', { sessionDbId }, error as Error);
        // Small backoff to prevent tight loop on DB error
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  private toPendingMessageWithId(msg: PersistentPendingMessage): PendingMessageWithId {
    const pending = this.store.toPendingMessage(msg);
    return {
      ...pending,
      _persistentId: msg.id,
      _originalTimestamp: msg.created_at_epoch
    };
  }

  /**
   * Wait for a message event or timeout.
   * @param signal - AbortSignal to cancel waiting
   * @param timeoutMs - Maximum time to wait before returning
   * @returns true if a message was received, false if timeout occurred
   */
  private waitForMessage(signal: AbortSignal, timeoutMs: number = IDLE_TIMEOUT_MS): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const onMessage = () => {
        cleanup();
        resolve(true);
      };

      const onAbort = () => {
        cleanup();
        resolve(false);
      };

      const onTimeout = () => {
        cleanup();
        resolve(false);
      };

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
      timeoutId = setTimeout(onTimeout, timeoutMs);
    });
  }
}
