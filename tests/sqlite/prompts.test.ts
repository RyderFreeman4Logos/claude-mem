/**
 * Prompts module tests
 * Tests modular prompt functions with in-memory database
 *
 * Sources:
 * - API patterns from src/services/sqlite/prompts/store.ts
 * - API patterns from src/services/sqlite/prompts/get.ts
 * - Test pattern from tests/session_store.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import {
  saveUserPrompt,
  getPromptNumberFromUserPrompts,
  getUnsyncedUserPromptsByContentSessionId,
  markPromptVectorSynced,
} from '../../src/services/sqlite/Prompts.js';
import { createSDKSession } from '../../src/services/sqlite/Sessions.js';
import type { Database } from 'bun:sqlite';

describe('Prompts Module', () => {
  let db: Database;

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
  });

  afterEach(() => {
    db.close();
  });

  // Helper to create a session (for FK constraint on user_prompts.content_session_id)
  function createSession(contentSessionId: string, project: string = 'test-project'): string {
    createSDKSession(db, contentSessionId, project, 'initial prompt');
    return contentSessionId;
  }

  describe('saveUserPrompt', () => {
    it('should store prompt and return numeric ID', () => {
      const contentSessionId = createSession('content-session-prompt-1');
      const promptNumber = 1;
      const promptText = 'First user prompt';

      const id = saveUserPrompt(db, contentSessionId, promptNumber, promptText);

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);
    });

    it('should store multiple prompts with incrementing IDs', () => {
      const contentSessionId = createSession('content-session-prompt-2');

      const id1 = saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      const id2 = saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      const id3 = saveUserPrompt(db, contentSessionId, 3, 'Third prompt');

      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);
      expect(id3).toBeGreaterThan(id2);
    });

    it('should allow prompts from different sessions', () => {
      const sessionA = createSession('session-a');
      const sessionB = createSession('session-b');

      const id1 = saveUserPrompt(db, sessionA, 1, 'Prompt A1');
      const id2 = saveUserPrompt(db, sessionB, 1, 'Prompt B1');

      expect(id1).not.toBe(id2);
    });
  });

  describe('getPromptNumberFromUserPrompts', () => {
    it('should return 0 when no prompts exist', () => {
      const count = getPromptNumberFromUserPrompts(db, 'nonexistent-session');

      expect(count).toBe(0);
    });

    it('should return count of prompts for session', () => {
      const contentSessionId = createSession('count-test-session');

      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(0);

      saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(1);

      saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(2);

      saveUserPrompt(db, contentSessionId, 3, 'Third prompt');
      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(3);
    });

    it('should maintain session isolation', () => {
      const sessionA = createSession('isolation-session-a');
      const sessionB = createSession('isolation-session-b');

      // Add prompts to session A
      saveUserPrompt(db, sessionA, 1, 'A1');
      saveUserPrompt(db, sessionA, 2, 'A2');

      // Add prompts to session B
      saveUserPrompt(db, sessionB, 1, 'B1');

      // Session A should have 2 prompts
      expect(getPromptNumberFromUserPrompts(db, sessionA)).toBe(2);

      // Session B should have 1 prompt
      expect(getPromptNumberFromUserPrompts(db, sessionB)).toBe(1);

      // Adding to session B shouldn't affect session A
      saveUserPrompt(db, sessionB, 2, 'B2');
      saveUserPrompt(db, sessionB, 3, 'B3');

      expect(getPromptNumberFromUserPrompts(db, sessionA)).toBe(2);
      expect(getPromptNumberFromUserPrompts(db, sessionB)).toBe(3);
    });

    it('should handle edge case of many prompts', () => {
      const contentSessionId = createSession('many-prompts-session');

      for (let i = 1; i <= 100; i++) {
        saveUserPrompt(db, contentSessionId, i, `Prompt ${i}`);
      }

      expect(getPromptNumberFromUserPrompts(db, contentSessionId)).toBe(100);
    });
  });

  describe('getUnsyncedUserPromptsByContentSessionId', () => {
    it('should return un-synced prompts in id order, not latest-only', () => {
      const contentSessionId = createSession('unsynced-prompts-session');
      const prompt1Id = saveUserPrompt(db, contentSessionId, 1, 'First prompt');
      const prompt2Id = saveUserPrompt(db, contentSessionId, 2, 'Second prompt');
      const prompt3Id = saveUserPrompt(db, contentSessionId, 3, 'Third prompt');

      markPromptVectorSynced(db, prompt2Id, Date.now());

      const prompts = getUnsyncedUserPromptsByContentSessionId(db, contentSessionId);

      expect(prompts.map(prompt => prompt.id)).toEqual([prompt1Id, prompt3Id]);
      expect(prompts.map(prompt => prompt.prompt_number)).toEqual([1, 3]);
      expect(prompts.every(prompt => prompt.vector_synced_at === null)).toBe(true);
    });
  });

  describe('markPromptVectorSynced', () => {
    it('should update vector_synced_at for the targeted prompt only', () => {
      const contentSessionId = createSession('mark-prompt-synced-session');
      const promptId = saveUserPrompt(db, contentSessionId, 1, 'Sync me');
      const otherPromptId = saveUserPrompt(db, contentSessionId, 2, 'Leave me pending');
      const syncedAt = Date.now();

      markPromptVectorSynced(db, promptId, syncedAt);

      const syncedPrompt = db.prepare(`
        SELECT vector_synced_at
        FROM user_prompts
        WHERE id = ?
      `).get(promptId) as { vector_synced_at: number | null };
      const pendingPrompt = db.prepare(`
        SELECT vector_synced_at
        FROM user_prompts
        WHERE id = ?
      `).get(otherPromptId) as { vector_synced_at: number | null };

      expect(syncedPrompt.vector_synced_at).toBe(syncedAt);
      expect(pendingPrompt.vector_synced_at).toBeNull();
    });
  });
});
