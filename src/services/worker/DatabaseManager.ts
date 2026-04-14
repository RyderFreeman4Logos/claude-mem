/**
 * DatabaseManager: Single long-lived database connection
 *
 * Responsibility:
 * - Manage single database connection for worker lifetime
 * - Provide centralized access to SessionStore and SessionSearch
 * - High-level database operations
 * - ChromaSync integration
 */

import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { SqliteVecSync } from '../sync/SqliteVecSync.js';
import {
  resolveVectorBackend,
  type VectorSyncBackend
} from '../sync/VectorBackend.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { DB_PATH, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import type { DBSession } from '../worker-types.js';

export class DatabaseManager {
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private vectorSync: VectorSyncBackend | null = null;

  constructor(private readonly dbPath: string = DB_PATH) {}

  /**
   * Initialize database connection (once, stays open)
   */
  async initialize(): Promise<void> {
    // Open database connection (ONCE)
    this.sessionStore = new SessionStore(this.dbPath);
    this.sessionSearch = new SessionSearch(this.dbPath);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const backend = resolveVectorBackend(settings);

    if (backend === 'chroma') {
      this.vectorSync = new ChromaSync('claude-mem');
    } else if (backend === 'sqlite-vec') {
      this.vectorSync = new SqliteVecSync('claude-mem', this.dbPath);
    } else {
      logger.info('DB', 'Vector search disabled by configuration');
    }

    logger.info('DB', 'Database initialized', { vectorBackend: backend });
  }

  /**
   * Close database connection and cleanup all resources
   */
  async close(): Promise<void> {
    // Close ChromaSync first (MCP connection lifecycle managed by ChromaMcpManager)
    if (this.vectorSync) {
      await this.vectorSync.close();
      this.vectorSync = null;
    }

    if (this.sessionStore) {
      this.sessionStore.close();
      this.sessionStore = null;
    }
    if (this.sessionSearch) {
      this.sessionSearch.close();
      this.sessionSearch = null;
    }
    logger.info('DB', 'Database closed');
  }

  /**
   * Get SessionStore instance (throws if not initialized)
   */
  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  /**
   * Get SessionSearch instance (throws if not initialized)
   */
  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  /**
   * Get ChromaSync instance (returns null if Chroma is disabled)
   */
  getVectorSync(): VectorSyncBackend | null {
    return this.vectorSync;
  }

  /**
   * Backward-compatible alias while search/storage call sites still reference Chroma naming.
   */
  getChromaSync(): VectorSyncBackend | null {
    return this.vectorSync;
  }

  // REMOVED: cleanupOrphanedSessions - violates "EVERYTHING SHOULD SAVE ALWAYS"
  // Worker restarts don't make sessions orphaned. Sessions are managed by hooks
  // and exist independently of worker state.

  /**
   * Get session by ID (throws if not found)
   */
  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    user_prompt: string;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
