import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { logger } from '../../src/utils/logger.js';

describe('SearchManager', () => {
  beforeEach(() => {
    (SearchManager as any).semanticSearchUnavailableWarningLogged = false;
    mock.restore();
  });

  it('surfaces semantic-search-disabled state instead of pretending there were no results', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});

    const manager = new SearchManager(
      {
        searchObservations: mock(() => [{
          id: 1,
          memory_session_id: 'session-123',
          project: 'test-project',
          text: 'Relevant observation',
          type: 'decision',
          title: 'Relevant observation',
          subtitle: null,
          facts: '[]',
          narrative: 'Relevant observation',
          concepts: '[]',
          files_read: '[]',
          files_modified: '[]',
          prompt_number: 1,
          discovery_tokens: 0,
          created_at: '2025-01-01T12:00:00.000Z',
          created_at_epoch: Date.now()
        }]),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
        findByType: mock(() => []),
        findByConcept: mock(() => []),
        findByFile: mock(() => ({ observations: [], sessions: [] }))
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => [])
      } as any,
      {
        queryChroma: mock(() => Promise.resolve({
          disabled: true,
          ids: [],
          distances: [],
          metadatas: []
        }))
      } as any,
      {} as any,
      {} as any
    );

    const result = await manager.search({ query: 'relevant observation' });
    const text = result.content[0].text;

    expect(text).toContain('Semantic search unavailable');
    expect(text).not.toContain('No results found');
    expect(warnSpy).toHaveBeenCalledWith(
      'SEARCH',
      'semantic search unavailable',
      expect.objectContaining({ tool: 'search', query: 'relevant observation' })
    );
  });

  it('includes semanticSearchDisabled in json output', async () => {
    const manager = new SearchManager(
      {
        searchObservations: mock(() => []),
        searchSessions: mock(() => []),
        searchUserPrompts: mock(() => []),
        findByType: mock(() => []),
        findByConcept: mock(() => []),
        findByFile: mock(() => ({ observations: [], sessions: [] }))
      } as any,
      {
        getObservationsByIds: mock(() => []),
        getSessionSummariesByIds: mock(() => []),
        getUserPromptsByIds: mock(() => [])
      } as any,
      {
        queryChroma: mock(() => Promise.resolve({
          disabled: true,
          ids: [],
          distances: [],
          metadatas: []
        }))
      } as any,
      {} as any,
      {} as any
    );

    const result = await manager.search({ query: 'relevant observation', format: 'json' });

    expect(result.semanticSearchDisabled).toBe(true);
    expect(result.query).toBe('relevant observation');
  });
});
