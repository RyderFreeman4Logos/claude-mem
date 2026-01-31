import { Database } from './sqlite-compat.js';
import type { PendingMessage } from '../worker-types.js';
import { logger } from '../../utils/logger.js';

/**
 * Persistent pending message record from database
 */
export interface PersistentPendingMessage {
  id: number;
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  retry_count: number;
  created_at_epoch: number;
  started_processing_at_epoch: number | null;
  completed_at_epoch: number | null;
  last_attempted_at_epoch: number | null;
}

/**
 * PendingMessageStore - Persistent work queue for SDK messages
 *
 * Messages are persisted before processing using a two-phase commit pattern.
 * This ensures messages survive Worker crashes and can be recovered on restart.
 *
 * Lifecycle:
 * 1. enqueue() - Message persisted with status 'pending'
 * 2. claim() - Atomically claims message (status -> 'processing')
 * 3. complete() - After successful processing, delete the message
 *
 * Recovery:
 * - resetStuckMessages() - Reset 'processing' messages to 'pending' on startup
 * - getSessionsWithPendingMessages() - Find sessions that need recovery
 */
export class PendingMessageStore {
  private db: Database;
  private maxRetries: number;

  constructor(db: Database, maxRetries: number = 3) {
    this.db = db;
    this.maxRetries = maxRetries;
  }

  /**
   * Enqueue a new message (persist before processing)
   * @returns The database ID of the persisted message (existing or newly created)
   */
  enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): number {
    const now = Date.now();

    // Check for duplicate messages before inserting
    let existingMessage: { id: number } | undefined;

    if (message.type === 'observation' && message.prompt_number !== undefined) {
      // For observation messages: check (session_db_id, message_type='observation', prompt_number)
      const checkStmt = this.db.prepare(`
        SELECT id FROM pending_messages
        WHERE session_db_id = ?
          AND message_type = 'observation'
          AND prompt_number = ?
        LIMIT 1
      `);
      existingMessage = checkStmt.get(sessionDbId, message.prompt_number) as { id: number } | undefined;

      if (existingMessage) {
        logger.debug('QUEUE', 'Observation message already exists, skipping enqueue', {
          sessionDbId,
          promptNumber: message.prompt_number,
          existingMessageId: existingMessage.id
        });
        return existingMessage.id;
      }
    } else if (message.type === 'summarize') {
      // For summarize messages: check (session_db_id, message_type='summarize', prompt_number=NULL)
      const checkStmt = this.db.prepare(`
        SELECT id FROM pending_messages
        WHERE session_db_id = ?
          AND message_type = 'summarize'
          AND prompt_number IS NULL
        LIMIT 1
      `);
      existingMessage = checkStmt.get(sessionDbId) as { id: number } | undefined;

      if (existingMessage) {
        logger.debug('QUEUE', 'Summarize message already exists, skipping enqueue', {
          sessionDbId,
          existingMessageId: existingMessage.id
        });
        return existingMessage.id;
      }
    }

    // No duplicate found, proceed with insertion
    const stmt = this.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `);

    const result = stmt.run(
      sessionDbId,
      contentSessionId,
      message.type,
      message.tool_name || null,
      message.tool_input ? JSON.stringify(message.tool_input) : null,
      message.tool_response ? JSON.stringify(message.tool_response) : null,
      message.cwd || null,
      message.last_assistant_message || null,
      message.prompt_number || null,
      now
    );

    return result.lastInsertRowid as number;
  }

  /**
   * Atomically claim the next pending message.
   * Finds oldest pending -> updates status to 'processing' -> returns it.
   * Message stays in database until complete() is called.
   * Uses a transaction to prevent race conditions.
   */
  claimAndDelete(sessionDbId: number): PersistentPendingMessage | null {
    const claimTx = this.db.transaction((sessionId: number) => {
      // Process most recent messages first (LIFO) to ensure latest context
      // is available for SessionStart injection after auto-compact
      // Apply exponential backoff: skip messages that failed recently
      const backoffCutoff = Date.now() - this.getRetryDelayForSession(sessionId);

      const peekStmt = this.db.prepare(`
        SELECT * FROM pending_messages
        WHERE session_db_id = ?
          AND status = 'pending'
          AND (last_attempted_at_epoch IS NULL OR last_attempted_at_epoch < ?)
        ORDER BY created_at_epoch DESC
        LIMIT 1
      `);
      const msg = peekStmt.get(sessionId, backoffCutoff) as PersistentPendingMessage | null;

      if (msg) {
        // Update status to processing - message stays in database
        const updateStmt = this.db.prepare(`
          UPDATE pending_messages
          SET status = 'processing',
              started_processing_at_epoch = ?,
              last_attempted_at_epoch = ?,
              retry_count = retry_count + 1
          WHERE id = ?
        `);
        const now = Date.now();
        updateStmt.run(now, now, msg.id);

        // Log claim with minimal info (avoid logging full payload)
        logger.info('QUEUE', `CLAIMED | sessionDbId=${sessionId} | messageId=${msg.id} | type=${msg.message_type} | retry=${msg.retry_count + 1}`, {
          sessionId: sessionId
        });
      }
      return msg;
    });

    return claimTx(sessionDbId) as PersistentPendingMessage | null;
  }

  /**
   * Calculate retry delay based on retry count (exponential backoff).
   * Returns delay in milliseconds.
   */
  private getRetryDelay(retryCount: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 60s
    const baseDelay = 1000;
    const maxDelay = 60000;
    return Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
  }

  /**
   * Calculate the cutoff time for message retry based on session's retry count.
   * Returns the epoch timestamp before which messages should be skipped.
   */
  private getRetryDelayForSession(sessionDbId: number): number {
    // Get the max retry count for pending messages in this session
    const stmt = this.db.prepare(`
      SELECT MAX(retry_count) as max_retries
      FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
    `);
    const result = stmt.get(sessionDbId) as { max_retries: number } | undefined;
    const maxRetries = result?.max_retries ?? 0;
    // Use average delay based on max retries seen
    return this.getRetryDelay(Math.max(0, maxRetries - 1));
  }

  /**
   * Mark a message as successfully completed and delete it from the queue.
   * Must be called after the message has been fully processed.
   */
  complete(messageId: number): void {
    const stmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
    const result = stmt.run(messageId);

    if (result.changes > 0) {
      logger.info('QUEUE', `COMPLETED | messageId=${messageId}`);
    }
  }

  /**
   * Get all pending messages for session (ordered by creation time)
   */
  getAllPending(sessionDbId: number): PersistentPendingMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
    `);
    return stmt.all(sessionDbId) as PersistentPendingMessage[];
  }

  /**
   * Get all queue messages (for UI display)
   * Returns pending, processing, and failed messages (not processed - they're deleted)
   * Joins with sdk_sessions to get project name
   */
  getQueueMessages(): (PersistentPendingMessage & { project: string | null })[] {
    const stmt = this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status IN ('pending', 'processing', 'failed')
      ORDER BY
        CASE pm.status
          WHEN 'failed' THEN 0
          WHEN 'processing' THEN 1
          WHEN 'pending' THEN 2
        END,
        pm.created_at_epoch ASC
    `);
    return stmt.all() as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Get count of stuck messages (processing longer than threshold)
   */
  getStuckCount(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);
    const result = stmt.get(cutoff) as { count: number };
    return result.count;
  }

  /**
   * Retry a specific message (reset to pending)
   * Works for pending (re-queue), processing (reset stuck), and failed messages
   */
  retryMessage(messageId: number): boolean {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE id = ? AND status IN ('pending', 'processing', 'failed')
    `);
    const result = stmt.run(messageId);
    return result.changes > 0;
  }

  /**
   * Reset all processing messages for a session to pending
   * Used when force-restarting a stuck session
   */
  resetProcessingToPending(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status = 'processing'
    `);
    const result = stmt.run(sessionDbId);
    return result.changes;
  }

  /**
   * Mark all processing messages for a session as failed
   * Used in error recovery when session generator crashes
   * @returns Number of messages marked failed
   */
  markSessionMessagesFailed(sessionDbId: number): number {
    const now = Date.now();

    // Atomic update - all processing messages for session → failed
    // Note: This bypasses retry logic since generator failures are session-level,
    // not message-level. Individual message failures use markFailed() instead.
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE session_db_id = ? AND status = 'processing'
    `);

    const result = stmt.run(now, sessionDbId);
    return result.changes;
  }

  /**
   * Abort a specific message (delete from queue)
   */
  abortMessage(messageId: number): boolean {
    const stmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
    const result = stmt.run(messageId);
    return result.changes > 0;
  }

  /**
   * Retry all stuck messages at once
   */
  retryAllStuck(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get recently processed messages (for UI feedback)
   * Shows messages completed in the last N minutes so users can see their stuck items were processed
   */
  getRecentlyProcessed(limit: number = 10, withinMinutes: number = 30): (PersistentPendingMessage & { project: string | null })[] {
    const cutoff = Date.now() - (withinMinutes * 60 * 1000);
    const stmt = this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status = 'processed' AND pm.completed_at_epoch > ?
      ORDER BY pm.completed_at_epoch DESC
      LIMIT ?
    `);
    return stmt.all(cutoff, limit) as (PersistentPendingMessage & { project: string | null })[];
  }

  /**
   * Mark message as failed (status: pending -> failed or back to pending for retry)
   * If retry_count < maxRetries, moves back to 'pending' for retry
   * Otherwise marks as 'failed' permanently
   */
  markFailed(messageId: number): void {
    const now = Date.now();

    // Get current retry count
    const msg = this.db.prepare('SELECT retry_count FROM pending_messages WHERE id = ?').get(messageId) as { retry_count: number } | undefined;

    if (!msg) return;

    if (msg.retry_count < this.maxRetries) {
      // Move back to pending for retry
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'pending', retry_count = retry_count + 1, started_processing_at_epoch = NULL
        WHERE id = ?
      `);
      stmt.run(messageId);
    } else {
      // Max retries exceeded, mark as permanently failed
      const stmt = this.db.prepare(`
        UPDATE pending_messages
        SET status = 'failed', completed_at_epoch = ?
        WHERE id = ?
      `);
      stmt.run(now, messageId);
    }
  }

  /**
   * Reset stuck messages (processing -> pending if stuck longer than threshold)
   * @param thresholdMs Messages processing longer than this are considered stuck (0 = reset all)
   * @returns Number of messages reset
   */
  resetStuckMessages(thresholdMs: number): number {
    const cutoff = thresholdMs === 0 ? Date.now() : Date.now() - thresholdMs;

    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `);

    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get count of pending messages for a session
   */
  getPendingCount(sessionDbId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `);
    const result = stmt.get(sessionDbId) as { count: number };
    return result.count;
  }

  /**
   * Check if any session has pending work
   */
  hasAnyPendingWork(): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `);
    const result = stmt.get() as { count: number };
    return result.count > 0;
  }

  /**
   * Get all session IDs that have pending messages (for recovery on startup)
   * Excludes messages that are older than the max age threshold (orphaned messages)
   */
  getSessionsWithPendingMessages(maxAgeHours: number = 24): number[] {
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;

    const stmt = this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
        AND created_at_epoch > ?
    `);
    const results = stmt.all(cutoff) as { session_db_id: number }[];
    return results.map(r => r.session_db_id);
  }

  /**
   * Mark old pending messages as failed (orphan cleanup)
   * Messages older than threshold are considered orphaned and marked as failed
   * @param maxAgeHours Messages older than this are considered orphaned
   * @returns Number of messages marked as failed
   */
  markOldMessagesAsFailed(maxAgeHours: number = 24): number {
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    const now = Date.now();

    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'failed', failed_at_epoch = ?
      WHERE status IN ('pending', 'processing')
        AND created_at_epoch < ?
    `);

    const result = stmt.run(now, cutoff);
    return result.changes;
  }

  /**
   * Get session info for a pending message (for recovery)
   */
  getSessionInfoForMessage(messageId: number): { sessionDbId: number; contentSessionId: string } | null {
    const stmt = this.db.prepare(`
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `);
    const result = stmt.get(messageId) as { session_db_id: number; content_session_id: string } | undefined;
    return result ? { sessionDbId: result.session_db_id, contentSessionId: result.content_session_id } : null;
  }

  /**
   * Clear all failed messages from the queue
   * @returns Number of messages deleted
   */
  clearFailed(): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status = 'failed'
    `);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Clear all pending, processing, and failed messages from the queue
   * Keeps only processed messages (for history)
   * @returns Number of messages deleted
   */
  clearAll(): number {
    const stmt = this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status IN ('pending', 'processing', 'failed')
    `);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Convert a PersistentPendingMessage back to PendingMessage format
   */
  toPendingMessage(persistent: PersistentPendingMessage): PendingMessage {
    return {
      type: persistent.message_type,
      tool_name: persistent.tool_name || undefined,
      tool_input: persistent.tool_input ? JSON.parse(persistent.tool_input) : undefined,
      tool_response: persistent.tool_response ? JSON.parse(persistent.tool_response) : undefined,
      prompt_number: persistent.prompt_number || undefined,
      cwd: persistent.cwd || undefined,
      last_assistant_message: persistent.last_assistant_message || undefined
    };
  }
}
