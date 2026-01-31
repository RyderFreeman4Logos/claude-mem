import { EventEmitter } from 'events';
import { PendingMessageStore, PersistentPendingMessage } from '../sqlite/PendingMessageStore.js';
import type { PendingMessageWithId } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

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
   */
  async *createIterator(sessionDbId: number, signal: AbortSignal): AsyncIterableIterator<PendingMessageWithId> {
    let currentMessageId: number | null = null;

    try {
      while (!signal.aborted) {
        try {
          // Complete previous message (if any) before claiming next one
          // This ensures messages are only deleted after successful processing
          if (currentMessageId !== null) {
            this.store.complete(currentMessageId);
            currentMessageId = null;
          }

          // Atomically claim next message (status -> 'processing')
          const persistentMessage = this.store.claimAndDelete(sessionDbId);

          if (persistentMessage) {
            // Track this message so we can complete it after processing
            currentMessageId = persistentMessage.id;

            // Yield the message for processing (it's still in DB as 'processing')
            yield this.toPendingMessageWithId(persistentMessage);
          } else {
            // Queue empty - wait for wake-up event
            await this.waitForMessage(signal);
          }
        } catch (error) {
          if (signal.aborted) return;
          logger.error('SESSION', 'Error in queue processor loop', { sessionDbId }, error as Error);
          // Small backoff to prevent tight loop on DB error
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } finally {
      // Complete the last message when iterator is closed (e.g., session ended)
      // This handles normal completion - crashes will leave message in 'processing'
      // which will be recovered on next Worker startup
      if (currentMessageId !== null) {
        try {
          this.store.complete(currentMessageId);
        } catch (error) {
          logger.error('SESSION', 'Failed to complete message on iterator close', {
            sessionDbId,
            messageId: currentMessageId
          }, error as Error);
        }
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

  private waitForMessage(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const onMessage = () => {
        cleanup();
        resolve();
      };

      const onAbort = () => {
        cleanup();
        resolve(); // Resolve to let the loop check signal.aborted and exit
      };

      const cleanup = () => {
        this.events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };

      this.events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
