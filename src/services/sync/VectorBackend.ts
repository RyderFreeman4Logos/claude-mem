import type { SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import type { ParsedObservation, ParsedSummary } from '../../sdk/parser.js';
import { logger } from '../../utils/logger.js';

export type VectorBackendName = 'chroma' | 'sqlite-vec';
export type VectorBackendSelection = VectorBackendName | 'disabled';

export interface VectorQueryEnabledResult {
  disabled?: false;
  notReady?: false;
  ids: number[];
  distances: number[];
  metadatas: any[];
}

export interface VectorQueryDisabledResult {
  disabled: true;
  ids: [];
  distances: [];
  metadatas: [];
}

export interface VectorQueryNotReadyResult {
  notReady: true;
  message: string;
  ids: [];
  distances: [];
  metadatas: [];
}

export type VectorQueryResult =
  | VectorQueryEnabledResult
  | VectorQueryDisabledResult
  | VectorQueryNotReadyResult;

export function isVectorQueryDisabledResult(
  result: VectorQueryResult
): result is VectorQueryDisabledResult {
  return result.disabled === true;
}

export function isVectorQueryNotReadyResult(
  result: VectorQueryResult
): result is VectorQueryNotReadyResult {
  return result.notReady === true;
}

export interface VectorSyncBackend {
  readonly backend: VectorBackendName;
  syncObservation(
    observationId: number,
    memorySessionId: string,
    project: string,
    obs: ParsedObservation,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens?: number
  ): Promise<void>;
  syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: ParsedSummary,
    promptNumber: number,
    createdAtEpoch: number,
    discoveryTokens?: number
  ): Promise<void>;
  syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number
  ): Promise<void>;
  queryChroma(
    query: string,
    limit: number,
    whereFilter?: Record<string, any>
  ): Promise<VectorQueryResult>;
  close(): Promise<void>;
}

export function resolveVectorBackend(settings: SettingsDefaults): VectorBackendSelection {
  const configured = settings.CLAUDE_MEM_VECTOR_BACKEND?.trim();

  if (configured === 'sqlite-vec') {
    return 'sqlite-vec';
  }

  if (configured === 'chroma' || configured === '') {
    return settings.CLAUDE_MEM_CHROMA_ENABLED === 'false' ? 'disabled' : 'chroma';
  }

  if (configured) {
    logger.warn('VECTOR_BACKEND', 'Unknown CLAUDE_MEM_VECTOR_BACKEND override, falling back to chroma compatibility mode', {
      configured
    });
  }

  if (settings.CLAUDE_MEM_CHROMA_ENABLED === 'false') {
    return 'disabled';
  }

  return 'chroma';
}
