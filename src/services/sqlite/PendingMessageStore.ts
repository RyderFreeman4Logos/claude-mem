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
 * Failed message record from dead letter queue
 */
export interface FailedMessage {
  id: number;
  original_id: number | null;
  session_db_id: number;
  content_session_id: string;
  message_type: 'observation' | 'summarize';
  tool_name: string | null;
  tool_input: string | null;
  tool_response: string | null;
  cwd: string | null;
  last_assistant_message: string | null;
  prompt_number: number | null;
  retry_count: number;
  created_at_epoch: number;
  failed_at_epoch: number;
  fail_reason: string;
  retry_history: string | null;
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
   * Returns pending and processing messages (failed messages are now in failed_messages table)
   * Joins with sdk_sessions to get project name
   */
  getQueueMessages(): (PersistentPendingMessage & { project: string | null })[] {
    const stmt = this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status IN ('pending', 'processing')
      ORDER BY
        CASE pm.status
          WHEN 'processing' THEN 0
          WHEN 'pending' THEN 1
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
   * Works for pending (re-queue), processing (reset stuck) messages
   * For failed messages, use retryFailedMessage() instead
   */
  retryMessage(messageId: number): boolean {
    const stmt = this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE id = ? AND status IN ('pending', 'processing')
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
   * Mark all processing messages for a session as failed and move to dead letter queue
   * Used in error recovery when session generator crashes
   * @returns Number of messages moved to dead letter queue
   */
  markSessionMessagesFailed(sessionDbId: number): number {
    const now = Date.now();

    // Get all processing messages for this session
    const selectStmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'processing'
    `);
    const messagesToMove = selectStmt.all(sessionDbId) as PersistentPendingMessage[];

    if (messagesToMove.length === 0) {
      return 0;
    }

    // Move each message to failed_messages table
    const insertStmt = this.db.prepare(`
      INSERT INTO failed_messages (
        original_id, session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd, last_assistant_message,
        prompt_number, retry_count, created_at_epoch, failed_at_epoch,
        fail_reason, retry_history
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteStmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');

    let movedCount = 0;
    for (const msg of messagesToMove) {
      try {
        const retryHistory = JSON.stringify([{
          attempted_at: msg.last_attempted_at_epoch,
          failed_at: now,
          reason: 'generator_crashed'
        }]);

        insertStmt.run(
          msg.id,
          msg.session_db_id,
          msg.content_session_id,
          msg.message_type,
          msg.tool_name,
          msg.tool_input,
          msg.tool_response,
          msg.cwd,
          msg.last_assistant_message,
          msg.prompt_number,
          msg.retry_count,
          msg.created_at_epoch,
          now,
          'generator_crashed',
          retryHistory
        );

        deleteStmt.run(msg.id);
        movedCount++;
      } catch (error) {
        logger.error('QUEUE', `Failed to move message ${msg.id} to dead letter queue`, {}, error as Error);
      }
    }

    return movedCount;
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
   * Otherwise moves to dead letter queue (failed_messages table)
   */
  markFailed(messageId: number): void {
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
      // Max retries exceeded, move to dead letter queue
      this.moveToDeadLetterQueue(messageId, 'max_retries_exceeded');
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
   * Reset timed out messages (processing -> pending if processing longer than timeout)
   * This is used for automatic timeout-based recovery during runtime.
   *
   * IMPORTANT: Excludes messages from active sessions to avoid resetting
   * messages that are being legitimately processed by active generators.
   *
   * @param timeoutMs Messages processing longer than this are reset to pending
   * @param activeSessionDbIds Array of session IDs that are currently active (should not be reset)
   * @returns Object with count of reset messages and array of reset message IDs
   */
  resetTimedOutMessages(timeoutMs: number, activeSessionDbIds: number[] = []): { count: number; messageIds: number[] } {
    const cutoff = Date.now() - timeoutMs;

    // Build the query - exclude active sessions
    let query = `
      SELECT id FROM pending_messages
      WHERE status = 'processing'
        AND started_processing_at_epoch < ?
    `;
    const params: (number | string)[] = [cutoff];

    if (activeSessionDbIds.length > 0) {
      query += ` AND session_db_id NOT IN (${activeSessionDbIds.map(() => '?').join(',')})`;
      params.push(...activeSessionDbIds);
    }

    // First, get the IDs of messages that will be reset (for logging)
    const selectStmt = this.db.prepare(query);
    const messagesToReset = selectStmt.all(...params) as { id: number }[];
    const messageIds = messagesToReset.map(m => m.id);

    if (messageIds.length === 0) {
      return { count: 0, messageIds: [] };
    }

    // Reset the timed out messages (same WHERE clause)
    let updateQuery = `
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing'
        AND started_processing_at_epoch < ?
    `;
    const updateParams: (number | string)[] = [cutoff];

    if (activeSessionDbIds.length > 0) {
      updateQuery += ` AND session_db_id NOT IN (${activeSessionDbIds.map(() => '?').join(',')})`;
      updateParams.push(...activeSessionDbIds);
    }

    const updateStmt = this.db.prepare(updateQuery);
    const result = updateStmt.run(...updateParams);

    return { count: result.changes, messageIds };
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
   * Mark old pending messages as failed and move to dead letter queue (orphan cleanup)
   * Messages older than threshold are considered orphaned and moved to failed_messages table
   * @param maxAgeHours Messages older than this are considered orphaned
   * @param failReason Reason for failure (default: 'orphaned')
   * @returns Number of messages moved to dead letter queue
   */
  markOldMessagesAsFailed(maxAgeHours: number = 24, failReason: string = 'orphaned'): number {
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const cutoff = Date.now() - maxAgeMs;
    const now = Date.now();

    // Get messages to move
    const selectStmt = this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE status IN ('pending', 'processing')
        AND created_at_epoch < ?
    `);
    const messagesToMove = selectStmt.all(cutoff) as PersistentPendingMessage[];

    if (messagesToMove.length === 0) {
      return 0;
    }

    // Move each message to failed_messages table
    const insertStmt = this.db.prepare(`
      INSERT INTO failed_messages (
        original_id, session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd, last_assistant_message,
        prompt_number, retry_count, created_at_epoch, failed_at_epoch,
        fail_reason, retry_history
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const deleteStmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');

    let movedCount = 0;
    for (const msg of messagesToMove) {
      try {
        const retryHistory = JSON.stringify([{
          attempted_at: msg.last_attempted_at_epoch,
          failed_at: now,
          reason: failReason
        }]);

        insertStmt.run(
          msg.id,
          msg.session_db_id,
          msg.content_session_id,
          msg.message_type,
          msg.tool_name,
          msg.tool_input,
          msg.tool_response,
          msg.cwd,
          msg.last_assistant_message,
          msg.prompt_number,
          msg.retry_count,
          msg.created_at_epoch,
          now,
          failReason,
          retryHistory
        );

        deleteStmt.run(msg.id);
        movedCount++;
      } catch (error) {
        logger.error('QUEUE', `Failed to move message ${msg.id} to dead letter queue`, {}, error as Error);
      }
    }

    return movedCount;
  }

  /**
   * Move a message to the dead letter queue
   * @param messageId The ID of the message to move
   * @param failReason The reason for failure
   * @returns true if successful
   */
  moveToDeadLetterQueue(messageId: number, failReason: string = 'max_retries_exceeded'): boolean {
    const now = Date.now();

    // Get the message
    const msg = this.db.prepare('SELECT * FROM pending_messages WHERE id = ?').get(messageId) as PersistentPendingMessage | undefined;
    if (!msg) return false;

    // Build retry history
    const retryHistory = JSON.stringify([{
      attempted_at: msg.last_attempted_at_epoch,
      failed_at: now,
      reason: failReason
    }]);

    // Insert into failed_messages
    const insertStmt = this.db.prepare(`
      INSERT INTO failed_messages (
        original_id, session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd, last_assistant_message,
        prompt_number, retry_count, created_at_epoch, failed_at_epoch,
        fail_reason, retry_history
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      insertStmt.run(
        msg.id,
        msg.session_db_id,
        msg.content_session_id,
        msg.message_type,
        msg.tool_name,
        msg.tool_input,
        msg.tool_response,
        msg.cwd,
        msg.last_assistant_message,
        msg.prompt_number,
        msg.retry_count,
        msg.created_at_epoch,
        now,
        failReason,
        retryHistory
      );

      // Delete from pending_messages
      const deleteStmt = this.db.prepare('DELETE FROM pending_messages WHERE id = ?');
      deleteStmt.run(messageId);

      logger.info('QUEUE', `Message ${messageId} moved to dead letter queue`, { failReason });
      return true;
    } catch (error) {
      logger.error('QUEUE', `Failed to move message ${messageId} to dead letter queue`, {}, error as Error);
      return false;
    }
  }

  /**
   * Get all failed messages from dead letter queue
   * Joins with sdk_sessions to get project name
   */
  getFailedMessages(limit: number = 100, offset: number = 0): (FailedMessage & { project: string | null })[] {
    const stmt = this.db.prepare(`
      SELECT fm.*, ss.project
      FROM failed_messages fm
      LEFT JOIN sdk_sessions ss ON fm.content_session_id = ss.content_session_id
      ORDER BY fm.failed_at_epoch DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset) as (FailedMessage & { project: string | null })[];
  }

  /**
   * Get count of failed messages in dead letter queue
   */
  getFailedMessageCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM failed_messages');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Get a specific failed message by ID
   */
  getFailedMessageById(id: number): FailedMessage | null {
    const stmt = this.db.prepare('SELECT * FROM failed_messages WHERE id = ?');
    const result = stmt.get(id) as FailedMessage | undefined;
    return result || null;
  }

  /**
   * Retry a failed message - move it back to pending_messages
   * @param failedMessageId The ID of the failed message to retry
   * @returns Object with success status and new message ID if successful
   */
  retryFailedMessage(failedMessageId: number): { success: boolean; newMessageId?: number; error?: string } {
    const now = Date.now();

    // Get the failed message
    const msg = this.getFailedMessageById(failedMessageId);
    if (!msg) {
      return { success: false, error: 'Failed message not found' };
    }

    // Parse retry history
    let retryHistory: Array<{ retried_at: number; previous_fail_reason: string }> = [];
    if (msg.retry_history) {
      try {
        retryHistory = JSON.parse(msg.retry_history);
      } catch {
        // Ignore parse error, start fresh
      }
    }

    // Add this retry attempt to history
    retryHistory.push({
      retried_at: now,
      previous_fail_reason: msg.fail_reason
    });

    // Check if message already exists in pending_messages (duplicate check)
    const existingCheck = this.db.prepare(`
      SELECT id FROM pending_messages
      WHERE session_db_id = ?
        AND message_type = ?
        AND (
          (prompt_number IS NOT NULL AND prompt_number = ?)
          OR (prompt_number IS NULL AND ? IS NULL)
        )
      LIMIT 1
    `);
    const existing = existingCheck.get(
      msg.session_db_id,
      msg.message_type,
      msg.prompt_number,
      msg.prompt_number
    ) as { id: number } | undefined;

    if (existing) {
      // Message already exists in pending, just delete from failed_messages
      this.db.prepare('DELETE FROM failed_messages WHERE id = ?').run(failedMessageId);
      return { success: true, newMessageId: existing.id, error: 'Message already exists in pending queue' };
    }

    // Insert back into pending_messages
    const insertStmt = this.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    try {
      const result = insertStmt.run(
        msg.session_db_id,
        msg.content_session_id,
        msg.message_type,
        msg.tool_name,
        msg.tool_input,
        msg.tool_response,
        msg.cwd,
        msg.last_assistant_message,
        msg.prompt_number,
        msg.retry_count,
        now // Use current time as new created_at
      );

      const newMessageId = result.lastInsertRowid as number;

      // Delete from failed_messages
      this.db.prepare('DELETE FROM failed_messages WHERE id = ?').run(failedMessageId);

      logger.info('QUEUE', `Failed message ${failedMessageId} retried, new message ID: ${newMessageId}`);
      return { success: true, newMessageId };
    } catch (error) {
      logger.error('QUEUE', `Failed to retry message ${failedMessageId}`, {}, error as Error);
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Retry all failed messages for a session
   * @param sessionDbId The session ID
   * @returns Number of messages retried
   */
  retryFailedMessagesForSession(sessionDbId: number): number {
    const stmt = this.db.prepare('SELECT id FROM failed_messages WHERE session_db_id = ?');
    const failedMessages = stmt.all(sessionDbId) as { id: number }[];

    let retriedCount = 0;
    for (const { id } of failedMessages) {
      const result = this.retryFailedMessage(id);
      if (result.success) {
        retriedCount++;
      }
    }

    return retriedCount;
  }

  /**
   * Delete a failed message permanently
   */
  deleteFailedMessage(failedMessageId: number): boolean {
    const stmt = this.db.prepare('DELETE FROM failed_messages WHERE id = ?');
    const result = stmt.run(failedMessageId);
    return result.changes > 0;
  }

  /**
   * Clear all failed messages from dead letter queue
   * @returns Number of messages deleted
   */
  clearFailedMessages(): number {
    const stmt = this.db.prepare('DELETE FROM failed_messages');
    const result = stmt.run();
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
   * Clear all failed messages from the dead letter queue
   * @returns Number of messages deleted
   */
  clearFailed(): number {
    return this.clearFailedMessages();
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
