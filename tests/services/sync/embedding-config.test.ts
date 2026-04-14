import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../../src/utils/logger.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import {
  EmbeddingClient,
  MISSING_EMBEDDING_URL_MESSAGE
} from '../../../src/services/sync/EmbeddingClient.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';

describe('Embedding configuration safeguards', () => {
  beforeEach(() => {
    (EmbeddingClient as any).instance = null;
    (ChromaSync as any).missingEmbeddingConfigWarningLogged = false;
  });

  afterEach(() => {
    mock.restore();
    (EmbeddingClient as any).instance = null;
    (ChromaSync as any).missingEmbeddingConfigWarningLogged = false;
  });

  it('throws a clear error when CLAUDE_MEM_EMBED_URL is empty', () => {
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      CLAUDE_MEM_EMBED_URL: ''
    } as any);

    expect(() => EmbeddingClient.getInstance()).toThrow(MISSING_EMBEDDING_URL_MESSAGE);
  });

  it('skips Chroma queries and warns once when the embedding endpoint is missing', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const getInstanceSpy = spyOn(EmbeddingClient, 'getInstance').mockImplementation(() => {
      throw new Error(MISSING_EMBEDDING_URL_MESSAGE);
    });

    const sync = new ChromaSync('test-project');

    await expect(sync.queryChroma('first query', 5)).resolves.toEqual({
      disabled: true,
      ids: [],
      distances: [],
      metadatas: [],
    });

    await expect(sync.queryChroma('second query', 5)).resolves.toEqual({
      disabled: true,
      ids: [],
      distances: [],
      metadatas: [],
    });

    expect(getInstanceSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'CHROMA_SYNC',
      'Skipping Chroma embedding operation because the endpoint is not configured',
      expect.objectContaining({ operation: 'query', project: 'test-project' }),
      MISSING_EMBEDDING_URL_MESSAGE
    );
  });

  it('skips Chroma sync operations without throwing when the embedding endpoint is missing', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    spyOn(EmbeddingClient, 'getInstance').mockImplementation(() => {
      throw new Error(MISSING_EMBEDDING_URL_MESSAGE);
    });

    const sync = new ChromaSync('test-project');

    await expect(sync.syncObservation(
      1,
      'memory-session',
      'test-project',
      {
        type: 'discovery',
        title: 'Missing embed URL',
        subtitle: null,
        facts: [],
        narrative: null,
        concepts: [],
        files_read: [],
        files_modified: []
      },
      1,
      Date.now()
    )).resolves.toBeUndefined();

    await expect(sync.syncSummary(
      2,
      'memory-session',
      'test-project',
      {
        request: 'request',
        investigated: 'investigated',
        learned: 'learned',
        completed: 'completed',
        next_steps: null,
        notes: null
      },
      1,
      Date.now()
    )).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'CHROMA_SYNC',
      'Skipping Chroma embedding operation because the endpoint is not configured',
      expect.objectContaining({ operation: 'sync', project: 'test-project' }),
      MISSING_EMBEDDING_URL_MESSAGE
    );
  });
});
