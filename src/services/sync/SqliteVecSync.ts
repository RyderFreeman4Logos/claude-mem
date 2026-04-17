/**
 * SqliteVecSync
 *
 * Vector storage/search backend backed by sqlite-vec inside claude-mem.db.
 * Chroma remains the default backend; sqlite-vec is opt-in via
 * CLAUDE_MEM_VECTOR_BACKEND=sqlite-vec.
 *
 * Rollback safety:
 * - schema changes are additive only
 * - the main database file remains claude-mem.db
 * - chroma-qwen3 is treated as read-only rollback data
 */

import { Database } from 'bun:sqlite';
import { DB_PATH, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';
import { parseFileList } from '../sqlite/observations/files.js';
import { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import {
  EmbeddingClient,
  isMissingEmbeddingConfigError,
  MISSING_EMBEDDING_URL_MESSAGE
} from './EmbeddingClient.js';
import type {
  VectorQueryResult,
  VectorSyncBackend
} from './VectorBackend.js';

interface VectorDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

interface StoredObservation {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface StoredSummary {
  id: number;
  memory_session_id: string;
  project: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  prompt_number: number;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

interface StoredUserPrompt {
  id: number;
  content_session_id: string;
  prompt_number: number;
  prompt_text: string;
  created_at: string;
  created_at_epoch: number;
  memory_session_id: string;
  project: string;
}

type SqliteVecRow = {
  rowid: number;
  sqlite_id: number;
  doc_type: string;
  memory_session_id: string;
  project: string;
  created_at_epoch: number;
  type: string | null;
  title: string | null;
  subtitle: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  field_type: string | null;
  prompt_number: number | null;
  distance: number;
};

type SqliteVecStateRow = {
  state_key: string;
  status: string;
  source: string;
  started_at_epoch: number | null;
  completed_at_epoch: number | null;
  last_error: string | null;
};

type QueryScope = {
  project?: string;
  docType?: string;
  observationType?: string;
};

const READY_STATE_KEY = 'sqlite_vec_readiness';
const NOT_READY_MESSAGE =
  'sqlite-vec backend not ready yet. Run scripts/migrate-chroma-to-sqlite-vec.py to import chroma-qwen3 before querying.';
const CHUNKS_TABLE = 'claude_mem_vec_chunks';
const STATE_TABLE = 'claude_mem_vec_state';
const EMBEDDINGS_TABLE = 'claude_mem_vec_embeddings';
const EMBEDDING_DIMENSION_PATTERN = /float\[(\d+)\]/;

export class SqliteVecSync implements VectorSyncBackend {
  private static missingEmbeddingConfigWarningLogged = false;
  readonly backend = 'sqlite-vec' as const;
  private readonly db: Database;
  private readonly batchSize = 20;
  private schemaReady = false;
  private extensionReady = false;

  private backgroundSyncInterval: ReturnType<typeof setInterval> | null = null;
  private backgroundSyncInFlight = false;
  private backgroundSyncStopped = false;
  private bgFailureCount = 0;
  private bgFailureLastLoggedAt = 0;
  private bgSuccessRowCount = 0;
  private bgSuccessDocCount = 0;
  private bgSuccessLastLoggedAt = 0;
  private static readonly BG_TICK_MS = 3000;
  private static readonly BG_LOG_THROTTLE_MS = 60_000;
  private static readonly BG_BATCH_ROWS = 10;

  constructor(
    private readonly project: string,
    private readonly dbPath: string = DB_PATH
  ) {
    this.db = new Database(this.dbPath, { create: true, readwrite: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA busy_timeout = 5000');
  }

  async close(): Promise<void> {
    await this.stopBackgroundSync();
    this.db.close();
  }

  startBackgroundSync(): void {
    if (this.backgroundSyncInterval) {
      return;
    }
    this.backgroundSyncStopped = false;
    logger.info('SQLITE_VEC', 'Background embed sync loop starting', {
      intervalMs: SqliteVecSync.BG_TICK_MS,
      batchRows: SqliteVecSync.BG_BATCH_ROWS
    });
    this.backgroundSyncInterval = setInterval(() => {
      this.runBackgroundTick().catch((error) => {
        this.recordBackgroundFailure(error);
      });
    }, SqliteVecSync.BG_TICK_MS);
  }

  async stopBackgroundSync(): Promise<void> {
    this.backgroundSyncStopped = true;
    if (this.backgroundSyncInterval) {
      clearInterval(this.backgroundSyncInterval);
      this.backgroundSyncInterval = null;
    }
    while (this.backgroundSyncInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async runBackgroundTick(): Promise<void> {
    if (this.backgroundSyncInFlight || this.backgroundSyncStopped) {
      return;
    }
    this.backgroundSyncInFlight = true;
    try {
      const embedClient = this.getEmbeddingClientOrSkip('sync');
      if (!embedClient) {
        return;
      }
      await this.ensureDatabaseReady();

      const processed =
        (await this.backgroundSyncObservationsBatch()) ||
        (await this.backgroundSyncSummariesBatch()) ||
        (await this.backgroundSyncPromptsBatch());

      if (processed) {
        this.bgFailureCount = 0;
        this.maybeLogBackgroundProgress();
      }
    } catch (error) {
      this.recordBackgroundFailure(error);
    } finally {
      this.backgroundSyncInFlight = false;
    }
  }

  private maybeLogBackgroundProgress(): void {
    const now = Date.now();
    if (now - this.bgSuccessLastLoggedAt >= SqliteVecSync.BG_LOG_THROTTLE_MS) {
      if (this.bgSuccessRowCount > 0) {
        logger.info('SQLITE_VEC', 'Background sync progress', {
          rows: this.bgSuccessRowCount,
          docs: this.bgSuccessDocCount,
          windowMs: SqliteVecSync.BG_LOG_THROTTLE_MS
        });
      }
      this.bgSuccessRowCount = 0;
      this.bgSuccessDocCount = 0;
      this.bgSuccessLastLoggedAt = now;
    }
  }

  private async backgroundSyncObservationsBatch(): Promise<boolean> {
    const rows = this.db.prepare(
      `
        SELECT o.id, o.memory_session_id, o.project, o.text, o.type, o.title, o.subtitle,
               o.facts, o.narrative, o.concepts, o.files_read, o.files_modified,
               o.prompt_number, o.discovery_tokens, o.created_at, o.created_at_epoch
        FROM observations o
        WHERE NOT EXISTS (
          SELECT 1 FROM ${CHUNKS_TABLE} c
          WHERE c.doc_type = 'observation'
            AND c.sqlite_id = o.id
            AND c.project = o.project
        )
          AND (
            (o.narrative IS NOT NULL AND TRIM(o.narrative) != '')
            OR (o.text IS NOT NULL AND TRIM(o.text) != '')
            OR (o.facts IS NOT NULL AND o.facts != '' AND o.facts != '[]' AND o.facts != 'null')
          )
        ORDER BY o.id ASC
        LIMIT ?
      `
    ).all(SqliteVecSync.BG_BATCH_ROWS) as StoredObservation[];

    if (rows.length === 0) {
      return false;
    }

    const docs: VectorDocument[] = [];
    for (const row of rows) {
      docs.push(...this.formatObservationDocs(row));
    }
    if (docs.length === 0) {
      return true;
    }
    await this.addDocuments(docs, 'sync');
    this.bgSuccessRowCount += rows.length;
    this.bgSuccessDocCount += docs.length;
    return true;
  }

  private async backgroundSyncSummariesBatch(): Promise<boolean> {
    const rows = this.db.prepare(
      `
        SELECT ss.id, ss.memory_session_id, ss.project, ss.request, ss.investigated,
               ss.learned, ss.completed, ss.next_steps, ss.notes, ss.prompt_number,
               ss.discovery_tokens, ss.created_at, ss.created_at_epoch
        FROM session_summaries ss
        WHERE NOT EXISTS (
          SELECT 1 FROM ${CHUNKS_TABLE} c
          WHERE c.doc_type = 'session_summary'
            AND c.sqlite_id = ss.id
            AND c.project = ss.project
        )
          AND (
            (ss.request IS NOT NULL AND TRIM(ss.request) != '')
            OR (ss.investigated IS NOT NULL AND TRIM(ss.investigated) != '')
            OR (ss.learned IS NOT NULL AND TRIM(ss.learned) != '')
            OR (ss.completed IS NOT NULL AND TRIM(ss.completed) != '')
            OR (ss.next_steps IS NOT NULL AND TRIM(ss.next_steps) != '')
            OR (ss.notes IS NOT NULL AND TRIM(ss.notes) != '')
          )
        ORDER BY ss.id ASC
        LIMIT ?
      `
    ).all(SqliteVecSync.BG_BATCH_ROWS) as StoredSummary[];

    if (rows.length === 0) {
      return false;
    }

    const docs: VectorDocument[] = [];
    for (const row of rows) {
      docs.push(...this.formatSummaryDocs(row));
    }
    if (docs.length === 0) {
      return true;
    }
    await this.addDocuments(docs, 'sync');
    this.bgSuccessRowCount += rows.length;
    this.bgSuccessDocCount += docs.length;
    return true;
  }

  private async backgroundSyncPromptsBatch(): Promise<boolean> {
    const rows = this.db.prepare(
      `
        SELECT up.id, up.content_session_id, up.prompt_number, up.prompt_text,
               up.created_at, up.created_at_epoch,
               s.memory_session_id, s.project
        FROM user_prompts up
        JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
        WHERE NOT EXISTS (
          SELECT 1 FROM ${CHUNKS_TABLE} c
          WHERE c.doc_type = 'user_prompt'
            AND c.sqlite_id = up.id
            AND c.project = s.project
        )
          AND up.prompt_text IS NOT NULL
          AND TRIM(up.prompt_text) != ''
        ORDER BY up.id ASC
        LIMIT ?
      `
    ).all(SqliteVecSync.BG_BATCH_ROWS) as StoredUserPrompt[];

    if (rows.length === 0) {
      return false;
    }

    const docs: VectorDocument[] = rows.map((row) => this.formatUserPromptDoc(row));
    if (docs.length === 0) {
      return true;
    }
    await this.addDocuments(docs, 'sync');
    this.bgSuccessRowCount += rows.length;
    this.bgSuccessDocCount += docs.length;
    return true;
  }

  private recordBackgroundFailure(error: unknown): void {
    this.bgFailureCount += 1;
    const now = Date.now();
    if (now - this.bgFailureLastLoggedAt >= SqliteVecSync.BG_LOG_THROTTLE_MS) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn('SQLITE_VEC', 'Background embed sync failing', {
        failures: this.bgFailureCount,
        windowMs: SqliteVecSync.BG_LOG_THROTTLE_MS,
        lastError: errMsg
      });
      this.bgFailureCount = 0;
      this.bgFailureLastLoggedAt = now;
    }
  }

  async syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    const stored: StoredObservation = {
      id: observationId,
      memory_session_id: memorySessionId,
      project,
      text: null,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch
    };

    await this.addDocuments(this.formatObservationDocs(stored), 'sync');
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens: number = 0
  ): Promise<void> {
    const stored: StoredSummary = {
      id: summaryId,
      memory_session_id: memorySessionId,
      project,
      request: summary.request,
      investigated: summary.investigated,
      learned: summary.learned,
      completed: summary.completed,
      next_steps: summary.next_steps,
      notes: summary.notes,
      prompt_number: promptNumber,
      discovery_tokens: discoveryTokens,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch
    };

    await this.addDocuments(this.formatSummaryDocs(stored), 'sync');
  }

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void> {
    const stored: StoredUserPrompt = {
      id: promptId,
      content_session_id: '',
      prompt_number: promptNumber,
      prompt_text: promptText,
      created_at: new Date(createdAtEpoch * 1000).toISOString(),
      created_at_epoch: createdAtEpoch,
      memory_session_id: memorySessionId,
      project
    };

    await this.addDocuments([this.formatUserPromptDoc(stored)], 'sync');
  }

  async queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<VectorQueryResult> {
    const embedClient = this.getEmbeddingClientOrSkip('query');
    if (!embedClient) {
      return { disabled: true, ids: [], distances: [], metadatas: [] };
    }

    await this.ensureDatabaseReady();

    const scope = this.extractQueryScope(whereFilter);
    if (!this.isBackendReadyForQuery(scope)) {
      return {
        notReady: true,
        message: NOT_READY_MESSAGE,
        ids: [],
        distances: [],
        metadatas: []
      };
    }

    const queryEmbedding = await embedClient.embedQuery(query);
    const jsonEmbedding = JSON.stringify(queryEmbedding);
    const { clause, params } = this.buildWhereClause(whereFilter);

    const rows = this.db.query(
      `
        SELECT
          metadata.rowid,
          metadata.sqlite_id,
          metadata.doc_type,
          metadata.memory_session_id,
          metadata.project,
          metadata.created_at_epoch,
          metadata.type,
          metadata.title,
          metadata.subtitle,
          metadata.concepts,
          metadata.files_read,
          metadata.files_modified,
          metadata.field_type,
          metadata.prompt_number,
          vec.distance
        FROM ${EMBEDDINGS_TABLE} AS vec
        JOIN ${CHUNKS_TABLE} AS metadata ON metadata.rowid = vec.rowid
        WHERE vec.embedding MATCH ?
          AND k = ?
          ${clause}
        ORDER BY vec.distance ASC
        LIMIT ?
      `
    ).all(jsonEmbedding, limit, ...params, limit) as SqliteVecRow[];

    const ids: number[] = [];
    const distances: number[] = [];
    const metadatas: any[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const resultKey = `${row.doc_type}:${row.sqlite_id}`;
      if (seen.has(resultKey)) {
        continue;
      }
      seen.add(resultKey);
      ids.push(row.sqlite_id);
      distances.push(row.distance);
      metadatas.push({
        sqlite_id: row.sqlite_id,
        doc_type: row.doc_type,
        memory_session_id: row.memory_session_id,
        project: row.project,
        created_at_epoch: row.created_at_epoch,
        type: row.type ?? undefined,
        title: row.title ?? undefined,
        subtitle: row.subtitle ?? undefined,
        concepts: row.concepts ?? undefined,
        files_read: row.files_read ?? undefined,
        files_modified: row.files_modified ?? undefined,
        field_type: row.field_type ?? undefined,
        prompt_number: row.prompt_number ?? undefined
      });
    }

    return { ids, distances, metadatas };
  }

  async deleteBySqliteId(
    sqliteId: number,
    options: {
      docType: string;
      project?: string;
    }
  ): Promise<void> {
    await this.ensureDatabaseReady();
    const { docType, project } = options;
    const filters = ['sqlite_id = ?', 'doc_type = ?'];
    const params: Array<number | string> = [sqliteId, docType];

    if (project) {
      filters.push('project = ?');
      params.push(project);
    }

    const rows = this.db.query(
      `SELECT rowid FROM ${CHUNKS_TABLE} WHERE ${filters.join(' AND ')}`
    ).all(...params) as Array<{ rowid: number }>;

    this.db.run('BEGIN');
    try {
      for (const row of rows) {
        this.db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE rowid = ?`).run(row.rowid);
        this.db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE rowid = ?`).run(row.rowid);
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  async deleteByChunkIds(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) {
      return;
    }

    await this.ensureDatabaseReady();
    const selectStmt = this.db.prepare(`SELECT rowid FROM ${CHUNKS_TABLE} WHERE chunk_id = ?`);

    this.db.run('BEGIN');
    try {
      for (const chunkId of chunkIds) {
        const row = selectStmt.get(chunkId) as { rowid: number } | null;
        if (!row) {
          continue;
        }
        this.db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE rowid = ?`).run(row.rowid);
        this.db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE rowid = ?`).run(row.rowid);
      }
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private async ensureDatabaseReady(): Promise<void> {
    if (!this.extensionReady) {
      const sqliteVec = await import('sqlite-vec');
      sqliteVec.load(this.db);
      this.extensionReady = true;
    }

    if (this.schemaReady) {
      return;
    }

    const embeddingDim = this.getConfiguredEmbeddingDimension();

    this.db.run(`
      CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
        rowid INTEGER PRIMARY KEY,
        chunk_id TEXT NOT NULL UNIQUE,
        sqlite_id INTEGER NOT NULL,
        doc_type TEXT NOT NULL,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        type TEXT,
        title TEXT,
        subtitle TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        field_type TEXT,
        prompt_number INTEGER,
        document_text TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sqlite_vec_chunks_project_doc
      ON ${CHUNKS_TABLE}(project, doc_type, created_at_epoch DESC)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sqlite_vec_chunks_sqlite_id
      ON ${CHUNKS_TABLE}(sqlite_id)
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
        state_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        started_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        last_error TEXT
      )
    `);

    const embeddingsTableSql = this.db.prepare(
      `SELECT sql FROM sqlite_master WHERE name = ?`
    ).get(EMBEDDINGS_TABLE) as { sql: string | null } | null;
    if (!embeddingsTableSql) {
      this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${EMBEDDINGS_TABLE}
        USING vec0(embedding float[${embeddingDim}])
      `);
    } else {
      const existingDim = this.extractEmbeddingDimension(embeddingsTableSql.sql);
      if (existingDim !== null && existingDim !== embeddingDim) {
        throw new Error(
          `sqlite-vec table dimension mismatch: expected ${embeddingDim}, found ${existingDim}. ` +
          'Remove claude_mem_vec_embeddings and rerun the migration with the current embedding config.'
        );
      }
    }

    this.schemaReady = true;
  }

  private getConfiguredEmbeddingDimension(): number {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const rawDim = settings.CLAUDE_MEM_EMBED_DIM || '4096';
    const parsed = Number.parseInt(rawDim, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid CLAUDE_MEM_EMBED_DIM: ${rawDim}`);
    }
    return parsed;
  }

  private extractEmbeddingDimension(sql: string | null): number | null {
    if (!sql) {
      return null;
    }
    const match = sql.match(EMBEDDING_DIMENSION_PATTERN);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private getEmbeddingClientOrSkip(operation: 'sync' | 'query'): EmbeddingClient | null {
    try {
      return EmbeddingClient.getInstance();
    } catch (error) {
      if (!isMissingEmbeddingConfigError(error)) {
        throw error;
      }

      if (!SqliteVecSync.missingEmbeddingConfigWarningLogged) {
        SqliteVecSync.missingEmbeddingConfigWarningLogged = true;
        logger.warn(
          'SQLITE_VEC',
          'Skipping sqlite-vec embedding operation because the endpoint is not configured',
          {
            project: this.project,
            operation
          },
          MISSING_EMBEDDING_URL_MESSAGE
        );
      }

      return null;
    }
  }

  private formatObservationDocs(obs: StoredObservation): VectorDocument[] {
    const documents: VectorDocument[] = [];
    const facts = obs.facts ? JSON.parse(obs.facts) : [];
    const concepts = obs.concepts ? JSON.parse(obs.concepts) : [];
    const filesRead = parseFileList(obs.files_read);
    const filesModified = parseFileList(obs.files_modified);

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: obs.id,
      doc_type: 'observation',
      memory_session_id: obs.memory_session_id,
      project: obs.project,
      created_at_epoch: obs.created_at_epoch,
      type: obs.type || 'discovery',
      title: obs.title || 'Untitled'
    };

    if (obs.subtitle) {
      baseMetadata.subtitle = obs.subtitle;
    }
    if (concepts.length > 0) {
      baseMetadata.concepts = concepts.join(',');
    }
    if (filesRead.length > 0) {
      baseMetadata.files_read = filesRead.join(',');
    }
    if (filesModified.length > 0) {
      baseMetadata.files_modified = filesModified.join(',');
    }

    if (obs.narrative) {
      documents.push({
        id: `obs_${obs.id}_narrative`,
        document: obs.narrative,
        metadata: { ...baseMetadata, field_type: 'narrative' }
      });
    }

    if (obs.text) {
      documents.push({
        id: `obs_${obs.id}_text`,
        document: obs.text,
        metadata: { ...baseMetadata, field_type: 'text' }
      });
    }

    facts.forEach((fact: string, index: number) => {
      if (!fact?.trim()) {
        return;
      }
      documents.push({
        id: `obs_${obs.id}_fact_${index}`,
        document: fact,
        metadata: { ...baseMetadata, field_type: 'fact', fact_index: index }
      });
    });

    return documents;
  }

  private formatSummaryDocs(summary: StoredSummary): VectorDocument[] {
    const documents: VectorDocument[] = [];

    const baseMetadata: Record<string, string | number> = {
      sqlite_id: summary.id,
      doc_type: 'session_summary',
      memory_session_id: summary.memory_session_id,
      project: summary.project,
      created_at_epoch: summary.created_at_epoch,
      prompt_number: summary.prompt_number || 0
    };

    const fields: Array<[string, string | null]> = [
      ['request', summary.request],
      ['investigated', summary.investigated],
      ['learned', summary.learned],
      ['completed', summary.completed],
      ['next_steps', summary.next_steps],
      ['notes', summary.notes]
    ];

    for (const [fieldType, value] of fields) {
      if (!value) {
        continue;
      }
      documents.push({
        id: `summary_${summary.id}_${fieldType}`,
        document: value,
        metadata: { ...baseMetadata, field_type: fieldType }
      });
    }

    return documents;
  }

  private formatUserPromptDoc(prompt: StoredUserPrompt): VectorDocument {
    return {
      id: `prompt_${prompt.id}`,
      document: prompt.prompt_text,
      metadata: {
        sqlite_id: prompt.id,
        doc_type: 'user_prompt',
        memory_session_id: prompt.memory_session_id,
        project: prompt.project,
        created_at_epoch: prompt.created_at_epoch,
        prompt_number: prompt.prompt_number
      }
    };
  }

  private async addDocuments(
    documents: VectorDocument[],
    operation: 'sync' | 'migration'
  ): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    const embedClient = this.getEmbeddingClientOrSkip(operation === 'migration' ? 'sync' : operation);
    if (!embedClient) {
      return;
    }

    await this.ensureDatabaseReady();

    const allEmbeddings: number[][] = [];
    for (let i = 0; i < documents.length; i += this.batchSize) {
      const batch = documents.slice(i, i + this.batchSize);
      const embeddings = await embedClient.embedDocuments(batch.map((doc) => doc.document));
      allEmbeddings.push(...embeddings);
    }

    this.upsertBatch(documents, allEmbeddings);
  }

  private upsertBatch(documents: VectorDocument[], embeddings: number[][]): void {
    const selectStmt = this.db.prepare(`SELECT rowid FROM ${CHUNKS_TABLE} WHERE chunk_id = ?`);
    const updateChunkStmt = this.db.prepare(`
      UPDATE ${CHUNKS_TABLE}
      SET sqlite_id = ?, doc_type = ?, memory_session_id = ?, project = ?,
          created_at_epoch = ?, type = ?, title = ?, subtitle = ?, concepts = ?,
          files_read = ?, files_modified = ?, field_type = ?, prompt_number = ?, document_text = ?
      WHERE rowid = ?
    `);
    const insertChunkStmt = this.db.prepare(`
      INSERT INTO ${CHUNKS_TABLE} (
        chunk_id, sqlite_id, doc_type, memory_session_id, project, created_at_epoch,
        type, title, subtitle, concepts, files_read, files_modified, field_type,
        prompt_number, document_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteEmbeddingStmt = this.db.prepare(`DELETE FROM ${EMBEDDINGS_TABLE} WHERE rowid = ?`);
    const insertEmbeddingStmt = this.db.prepare(`INSERT INTO ${EMBEDDINGS_TABLE}(rowid, embedding) VALUES (?, ?)`);

    this.db.run('BEGIN');

    try {
      for (let i = 0; i < documents.length; i++) {
        const document = documents[i];
        const embedding = embeddings[i];
        const metadata = document.metadata;
        const existing = selectStmt.get(document.id) as { rowid: number } | null;

        let rowid: number;
        if (existing) {
          rowid = existing.rowid;
          updateChunkStmt.run(
            metadata.sqlite_id,
            metadata.doc_type,
            metadata.memory_session_id,
            metadata.project,
            metadata.created_at_epoch,
            metadata.type ?? null,
            metadata.title ?? null,
            metadata.subtitle ?? null,
            metadata.concepts ?? null,
            metadata.files_read ?? null,
            metadata.files_modified ?? null,
            metadata.field_type ?? null,
            metadata.prompt_number ?? null,
            document.document,
            rowid
          );
          deleteEmbeddingStmt.run(rowid);
        } else {
          const result = insertChunkStmt.run(
            document.id,
            metadata.sqlite_id,
            metadata.doc_type,
            metadata.memory_session_id,
            metadata.project,
            metadata.created_at_epoch,
            metadata.type ?? null,
            metadata.title ?? null,
            metadata.subtitle ?? null,
            metadata.concepts ?? null,
            metadata.files_read ?? null,
            metadata.files_modified ?? null,
            metadata.field_type ?? null,
            metadata.prompt_number ?? null,
            document.document
          );
          rowid = Number(result.lastInsertRowid);
        }

        insertEmbeddingStmt.run(rowid, JSON.stringify(embedding));
      }

      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  private buildWhereClause(whereFilter?: Record<string, any>): { clause: string; params: any[] } {
    if (!whereFilter) {
      return { clause: '', params: [] };
    }

    const params: any[] = [];
    const conditions = this.flattenWhereFilter(whereFilter, params);
    if (conditions.length === 0) {
      return { clause: '', params };
    }

    return {
      clause: `AND ${conditions.join(' AND ')}`,
      params
    };
  }

  private flattenWhereFilter(filter: Record<string, any>, params: any[]): string[] {
    if (filter.$and && Array.isArray(filter.$and)) {
      return filter.$and.flatMap((entry: Record<string, any>) => this.flattenWhereFilter(entry, params));
    }

    const conditions: string[] = [];
    const mappings: Record<string, string> = {
      project: 'metadata.project',
      doc_type: 'metadata.doc_type',
      type: 'metadata.type',
      memory_session_id: 'metadata.memory_session_id'
    };

    for (const [key, value] of Object.entries(filter)) {
      if (key === '$and') {
        continue;
      }
      const column = mappings[key];
      if (!column) {
        continue;
      }
      conditions.push(`${column} = ?`);
      params.push(value);
    }

    return conditions;
  }

  private extractQueryScope(whereFilter?: Record<string, any>): QueryScope {
    return {
      project: this.extractScopeValue(whereFilter, 'project'),
      docType: this.extractScopeValue(whereFilter, 'doc_type'),
      observationType: this.extractScopeValue(whereFilter, 'type')
    };
  }

  private extractScopeValue(
    whereFilter: Record<string, any> | undefined,
    key: 'project' | 'doc_type' | 'type'
  ): string | undefined {
    if (!whereFilter) {
      return undefined;
    }

    const directValue = whereFilter[key];
    if (typeof directValue === 'string' && directValue.trim()) {
      return directValue;
    }

    if (Array.isArray(whereFilter.$and)) {
      for (const entry of whereFilter.$and) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }
        const nestedValue = this.extractScopeValue(entry, key);
        if (nestedValue) {
          return nestedValue;
        }
      }
    }

    return undefined;
  }

  private isBackendReadyForQuery(scope: QueryScope): boolean {
    const state = this.db.prepare(
      `SELECT * FROM ${STATE_TABLE} WHERE state_key = ?`
    ).get(READY_STATE_KEY) as SqliteVecStateRow | null;

    if (state && state.status !== 'complete') {
      return false;
    }

    const migrationCutoffEpoch = this.getMigrationCutoffEpoch(state);
    return !this.hasUnvectorizedSourceRecords(scope, migrationCutoffEpoch);
  }

  private getMigrationCutoffEpoch(state: SqliteVecStateRow | null): number | undefined {
    if (!state || state.status !== 'complete' || state.completed_at_epoch === null) {
      return undefined;
    }

    return state.completed_at_epoch;
  }

  private hasUnvectorizedSourceRecords(scope: QueryScope, cutoffEpoch?: number): boolean {
    if (!this.hasSourceTables()) {
      return false;
    }

    const { project, docType, observationType } = scope;

    if (docType === 'observation') {
      return this.hasUnvectorizedObservations(project, observationType, cutoffEpoch);
    }

    if (docType === 'session_summary') {
      return this.hasUnvectorizedSummaries(project, cutoffEpoch);
    }

    if (docType === 'user_prompt') {
      return this.hasUnvectorizedPrompts(project, cutoffEpoch);
    }

    return this.hasUnvectorizedObservations(project, observationType, cutoffEpoch)
      || this.hasUnvectorizedSummaries(project, cutoffEpoch)
      || this.hasUnvectorizedPrompts(project, cutoffEpoch);
  }

  private hasUnvectorizedObservations(
    project?: string,
    observationType?: string,
    cutoffEpoch?: number
  ): boolean {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (project) {
      conditions.push('o.project = ?');
      params.push(project);
    }

    if (observationType) {
      conditions.push('o.type = ?');
      params.push(observationType);
    }

    if (cutoffEpoch !== undefined) {
      conditions.push('o.created_at_epoch <= ?');
      params.push(cutoffEpoch);
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';
    const row = this.db.prepare(
      `
        SELECT 1 AS missing
        FROM observations o
        ${whereClause}
          ${whereClause ? 'AND' : 'WHERE'}
          NOT EXISTS (
            SELECT 1
            FROM ${CHUNKS_TABLE} c
            WHERE c.doc_type = 'observation'
              AND c.sqlite_id = o.id
              AND c.project = o.project
          )
        LIMIT 1
      `
    ).get(...params) as { missing: number } | null;

    return row !== null;
  }

  private hasUnvectorizedSummaries(project?: string, cutoffEpoch?: number): boolean {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (project) {
      conditions.push('ss.project = ?');
      params.push(project);
    }

    if (cutoffEpoch !== undefined) {
      conditions.push('ss.created_at_epoch <= ?');
      params.push(cutoffEpoch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(
      `
        SELECT 1 AS missing
        FROM session_summaries ss
        ${whereClause}
          ${whereClause ? 'AND' : 'WHERE'}
          NOT EXISTS (
            SELECT 1
            FROM ${CHUNKS_TABLE} c
            WHERE c.doc_type = 'session_summary'
              AND c.sqlite_id = ss.id
              AND c.project = ss.project
          )
        LIMIT 1
      `
    ).get(...params) as { missing: number } | null;

    return row !== null;
  }

  private hasUnvectorizedPrompts(project?: string, cutoffEpoch?: number): boolean {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (project) {
      conditions.push('s.project = ?');
      params.push(project);
    }

    if (cutoffEpoch !== undefined) {
      conditions.push('up.created_at_epoch <= ?');
      params.push(cutoffEpoch);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db.prepare(
      `
        SELECT 1 AS missing
        FROM user_prompts up
        JOIN sdk_sessions s ON s.content_session_id = up.content_session_id
        ${whereClause}
          ${whereClause ? 'AND' : 'WHERE'}
          NOT EXISTS (
            SELECT 1
            FROM ${CHUNKS_TABLE} c
            WHERE c.doc_type = 'user_prompt'
              AND c.sqlite_id = up.id
              AND c.project = s.project
          )
        LIMIT 1
      `
    ).get(...params) as { missing: number } | null;

    return row !== null;
  }

  private hasSourceTables(): boolean {
    const requiredTables = ['observations', 'session_summaries', 'user_prompts', 'sdk_sessions'];

    for (const tableName of requiredTables) {
      const row = this.db.prepare(
        `
          SELECT 1 AS present
          FROM sqlite_master
          WHERE type = 'table' AND name = ?
          LIMIT 1
        `
      ).get(tableName) as { present: number } | null;

      if (!row) {
        return false;
      }
    }

    return true;
  }
}
