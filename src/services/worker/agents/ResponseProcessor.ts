/**
 * ResponseProcessor: Shared response processing for all agent implementations
 *
 * Responsibility:
 * - Parse observations and summaries from agent responses
 * - Execute atomic database transactions
 * - Orchestrate Chroma sync (fire-and-forget)
 * - Broadcast to SSE clients
 * - Clean up processed messages
 *
 * This module extracts 150+ lines of duplicate code from SDKAgent, GeminiAgent, and OpenRouterAgent.
 */

import { logger } from '../../../utils/logger.js';
import { parseObservations, parseSummary, type ParsedObservation, type ParsedSummary } from '../../../sdk/parser.js';
import { updateCursorContextForProject } from '../../integrations/CursorHooksInstaller.js';
import { updateFolderClaudeMdFiles } from '../../../utils/claude-md-utils.js';
import { getWorkerPort } from '../../../shared/worker-utils.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';
import type { ActiveSession } from '../../worker-types.js';
import type { DatabaseManager } from '../DatabaseManager.js';
import type { SessionManager } from '../SessionManager.js';
import type { WorkerRef, StorageResult } from './types.js';
import type { PersistedSummaryPayload, StorageCommitResult } from '../storage/StorageTypes.js';
import { broadcastObservation, broadcastSummary } from './ObservationBroadcaster.js';
import { cleanupProcessedMessages } from './SessionCleanupHelper.js';

/**
 * Process agent response text (parse XML, save to database, sync to Chroma, broadcast SSE)
 *
 * This is the unified response processor that handles:
 * 1. Adding response to conversation history (for provider interop)
 * 2. Parsing observations and summaries from XML
 * 3. Atomic database transaction to store observations + summary
 * 4. Async Chroma sync (fire-and-forget, failures are non-critical)
 * 5. SSE broadcast to web UI clients
 * 6. Session cleanup
 *
 * @param text - Response text from the agent
 * @param session - Active session being processed
 * @param dbManager - Database manager for storage operations
 * @param sessionManager - Session manager for message tracking
 * @param worker - Worker reference for SSE broadcasting (optional)
 * @param discoveryTokens - Token cost delta for this response
 * @param originalTimestamp - Original epoch when message was queued (for accurate timestamps)
 * @param agentName - Name of the agent for logging (e.g., 'SDK', 'Gemini', 'OpenRouter')
 */
export async function processAgentResponse(
  text: string,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  modelId?: string
): Promise<void> {
  const parsed = parseAgentResponse(text, session, agentName);
  const result = storeParsedAgentResponseInline(
    parsed,
    session,
    dbManager,
    sessionManager,
    discoveryTokens,
    originalTimestamp,
    modelId
  );

  await finalizeSuccessfulPersist(
    parsed,
    result,
    session,
    dbManager,
    sessionManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );
}

export function parseAgentResponse(
  text: string,
  session: ActiveSession,
  agentName: string
): {
  observations: ParsedObservation[];
  summary: ParsedSummary | null;
} {
  session.lastGeneratorActivity = Date.now();

  if (text) {
    session.conversationHistory.push({ role: 'assistant', content: text });
  }

  const observations = parseObservations(text, session.contentSessionId);
  const summary = parseSummary(text, session.sessionDbId);

  if (
    text.trim() &&
    observations.length === 0 &&
    !summary &&
    !/<observation>|<summary>|<skip_summary\b/.test(text)
  ) {
    const preview = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    logger.warn('PARSER', `${agentName} returned non-XML response; observation content was discarded`, {
      sessionId: session.sessionDbId,
      preview
    });
  }

  return { observations, summary };
}

export async function enqueueAgentResponsePersist(
  parsed: { observations: ParsedObservation[]; summary: ParsedSummary | null; },
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  originalTimestamp: number | null,
  agentName: string,
  projectRoot?: string,
  modelId?: string
): Promise<void> {
  if (!worker?.storageCoordinator) {
    const inlineResult = storeParsedAgentResponseInline(
      parsed,
      session,
      dbManager,
      sessionManager,
      discoveryTokens,
      originalTimestamp,
      modelId
    );

    await finalizeSuccessfulPersist(
      parsed,
      inlineResult,
      session,
      dbManager,
      sessionManager,
      worker,
      discoveryTokens,
      agentName,
      projectRoot
    );
    return;
  }

  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  const processingMessageIds = [...session.processingMessageIds];
  const summaryForStore = normalizeSummaryForStorage(parsed.summary);
  const persistPromise = worker.storageCoordinator.enqueuePersist({
    sessionDbId: session.sessionDbId,
    contentSessionId: session.contentSessionId,
    memorySessionId: session.memorySessionId,
    project: session.project,
    platformSource: session.platformSource,
    lastPromptNumber: session.lastPromptNumber,
    discoveryTokens,
    originalTimestamp,
    modelId,
    processingMessageIds,
    observations: parsed.observations,
    summary: summaryForStore
  });

  session.processingMessageIds = [];
  session.deferredPersistCount = (session.deferredPersistCount ?? 0) + 1;

  void persistPromise
    .then((result) => finalizeSuccessfulPersist(
      parsed,
      result,
      session,
      dbManager,
      sessionManager,
      worker,
      discoveryTokens,
      agentName,
      projectRoot
    ))
    .catch((error) => {
      logger.error('DB', `${agentName} deferred persist failed`, {
        sessionId: session.sessionDbId,
        messageIds: processingMessageIds
      }, error as Error);

      cleanupProcessedMessages(session, worker);

      const remaining = sessionManager.getPendingMessageStore().getPendingCount(session.sessionDbId);
      if (remaining === 0 || session.quotaPaused) {
        sessionManager.removeSessionImmediate(session.sessionDbId);
      }
    })
    .finally(() => {
      session.deferredPersistCount = Math.max(0, (session.deferredPersistCount ?? 1) - 1);
    });
}

function normalizeSummaryForStorage(summary: ParsedSummary | null): PersistedSummaryPayload | null {
  if (!summary) {
    return null;
  }

  return {
    request: summary.request || '',
    investigated: summary.investigated || '',
    learned: summary.learned || '',
    completed: summary.completed || '',
    next_steps: summary.next_steps || '',
    notes: summary.notes
  };
}

function storeParsedAgentResponseInline(
  parsed: { observations: ParsedObservation[]; summary: ParsedSummary | null; },
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  discoveryTokens: number,
  originalTimestamp: number | null,
  modelId?: string
): StorageResult {
  const sessionStore = dbManager.getSessionStore();
  const pendingStore = sessionManager.getPendingMessageStore();
  const summaryForStore = normalizeSummaryForStorage(parsed.summary);

  if (!session.memorySessionId) {
    throw new Error('Cannot store observations: memorySessionId not yet captured');
  }

  sessionStore.ensureMemorySessionIdRegistered(session.sessionDbId, session.memorySessionId);

  logger.info('DB', `STORING | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${parsed.observations.length} | hasSummary=${!!summaryForStore}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  const result = sessionStore.storeObservations(
    session.memorySessionId,
    session.project,
    parsed.observations,
    summaryForStore,
    session.lastPromptNumber,
    discoveryTokens,
    originalTimestamp ?? undefined,
    modelId
  );

  logger.info('DB', `STORED | sessionDbId=${session.sessionDbId} | memorySessionId=${session.memorySessionId} | obsCount=${result.observationIds.length} | obsIds=[${result.observationIds.join(',')}] | summaryId=${result.summaryId || 'none'}`, {
    sessionId: session.sessionDbId,
    memorySessionId: session.memorySessionId
  });

  for (const messageId of session.processingMessageIds) {
    pendingStore.confirmProcessed(messageId);
  }
  if (session.processingMessageIds.length > 0) {
    logger.debug('QUEUE', `CONFIRMED_BATCH | sessionDbId=${session.sessionDbId} | count=${session.processingMessageIds.length} | ids=[${session.processingMessageIds.join(',')}]`);
  }
  session.processingMessageIds = [];

  return result;
}

async function finalizeSuccessfulPersist(
  parsed: { observations: ParsedObservation[]; summary: ParsedSummary | null; },
  result: StorageResult | StorageCommitResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  sessionManager: SessionManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  const summaryForStore = normalizeSummaryForStorage(parsed.summary);

  await syncAndBroadcastObservations(
    parsed.observations,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName,
    projectRoot
  );

  await syncAndBroadcastSummary(
    parsed.summary,
    summaryForStore,
    result,
    session,
    dbManager,
    worker,
    discoveryTokens,
    agentName
  );

  cleanupProcessedMessages(session, worker);

  const remaining = sessionManager.getPendingMessageStore().getPendingCount(session.sessionDbId);
  if (remaining === 0 || session.quotaPaused) {
    sessionManager.removeSessionImmediate(session.sessionDbId);
  }
}

/**
 * Sync observations to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastObservations(
  observations: ParsedObservation[],
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string,
  projectRoot?: string
): Promise<void> {
  for (let i = 0; i < observations.length; i++) {
    const obsId = result.observationIds[i];
    const obs = observations[i];
    const chromaStart = Date.now();

    // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
    dbManager.getChromaSync()?.syncObservation(
      obsId,
      session.contentSessionId,
      session.project,
      obs,
      session.lastPromptNumber,
      result.createdAtEpoch,
      discoveryTokens
    ).then(() => {
      const chromaDuration = Date.now() - chromaStart;
      logger.debug('CHROMA', 'Observation synced', {
        obsId,
        duration: `${chromaDuration}ms`,
        type: obs.type,
        title: obs.title || '(untitled)'
      });
    }).catch((error) => {
      logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
        obsId,
        type: obs.type,
        title: obs.title || '(untitled)'
      }, error);
    });

    // Broadcast to SSE clients (for web UI)
    // BUGFIX: Use obs.files_read and obs.files_modified (not obs.files)
    broadcastObservation(worker, {
      id: obsId,
      memory_session_id: session.memorySessionId,
      session_id: session.contentSessionId,
      platform_source: session.platformSource,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      text: null,  // text field is not in ParsedObservation
      narrative: obs.narrative || null,
      facts: JSON.stringify(obs.facts || []),
      concepts: JSON.stringify(obs.concepts || []),
      files_read: JSON.stringify(obs.files_read || []),
      files_modified: JSON.stringify(obs.files_modified || []),
      project: session.project,
      prompt_number: session.lastPromptNumber,
      created_at_epoch: result.createdAtEpoch
    });
  }

  // Update folder CLAUDE.md files for touched folders (fire-and-forget)
  // This runs per-observation batch to ensure folders are updated as work happens
  // Only runs if CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED is true (default: false)
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // Handle both string 'true' and boolean true from JSON settings
  const settingValue = settings.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED;
  const folderClaudeMdEnabled = settingValue === 'true' || settingValue === true;

  if (folderClaudeMdEnabled) {
    const allFilePaths: string[] = [];
    for (const obs of observations) {
      allFilePaths.push(...(obs.files_modified || []));
      allFilePaths.push(...(obs.files_read || []));
    }

    if (allFilePaths.length > 0) {
      updateFolderClaudeMdFiles(
        allFilePaths,
        session.project,
        getWorkerPort(),
        projectRoot
      ).catch(error => {
        logger.warn('FOLDER_INDEX', 'CLAUDE.md update failed (non-critical)', { project: session.project }, error as Error);
      });
    }
  }
}

/**
 * Sync summary to Chroma and broadcast to SSE clients
 */
async function syncAndBroadcastSummary(
  summary: ParsedSummary | null,
  summaryForStore: { request: string; investigated: string; learned: string; completed: string; next_steps: string; notes: string | null } | null,
  result: StorageResult,
  session: ActiveSession,
  dbManager: DatabaseManager,
  worker: WorkerRef | undefined,
  discoveryTokens: number,
  agentName: string
): Promise<void> {
  if (!summaryForStore || !result.summaryId) {
    return;
  }

  const chromaStart = Date.now();

  // Sync to Chroma (fire-and-forget, skipped if Chroma is disabled)
  dbManager.getChromaSync()?.syncSummary(
    result.summaryId,
    session.contentSessionId,
    session.project,
    summaryForStore,
    session.lastPromptNumber,
    result.createdAtEpoch,
    discoveryTokens
  ).then(() => {
    const chromaDuration = Date.now() - chromaStart;
    logger.debug('CHROMA', 'Summary synced', {
      summaryId: result.summaryId,
      duration: `${chromaDuration}ms`,
      request: summaryForStore.request || '(no request)'
    });
  }).catch((error) => {
    logger.error('CHROMA', `${agentName} chroma sync failed, continuing without vector search`, {
      summaryId: result.summaryId,
      request: summaryForStore.request || '(no request)'
    }, error);
  });

  // Broadcast to SSE clients (for web UI)
  broadcastSummary(worker, {
    id: result.summaryId,
    session_id: session.contentSessionId,
    platform_source: session.platformSource,
    request: summary!.request,
    investigated: summary!.investigated,
    learned: summary!.learned,
    completed: summary!.completed,
    next_steps: summary!.next_steps,
    notes: summary!.notes,
    project: session.project,
    prompt_number: session.lastPromptNumber,
    created_at_epoch: result.createdAtEpoch
  });

  // Update Cursor context file for registered projects (fire-and-forget)
  updateCursorContextForProject(session.project, getWorkerPort()).catch(error => {
    logger.warn('CURSOR', 'Context update failed (non-critical)', { project: session.project }, error as Error);
  });
}
