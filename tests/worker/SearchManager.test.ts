import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SearchManager } from '../../src/services/worker/SearchManager.js';
import { logger } from '../../src/utils/logger.js';

describe('SearchManager', () => {
  const buildManager = (
    queryChromaImpl: ReturnType<typeof mock>,
    sessionSearchOverrides: Record<string, any> = {},
    sessionStoreOverrides: Record<string, any> = {}
  ) => new SearchManager(
    {
      searchObservations: mock(() => []),
      searchSessions: mock(() => []),
      searchUserPrompts: mock(() => []),
      findByType: mock(() => []),
      findByConcept: mock(() => []),
      findByFile: mock(() => ({ observations: [], sessions: [] })),
      ...sessionSearchOverrides
    } as any,
    {
      getObservationsByIds: mock(() => []),
      getSessionSummariesByIds: mock(() => []),
      getUserPromptsByIds: mock(() => []),
      getTimelineAroundObservation: mock(() => []),
      getTimelineAroundTimestamp: mock(() => []),
      ...sessionStoreOverrides
    } as any,
    { queryChroma: queryChromaImpl } as any,
    {
      formatTableHeader: mock(() => 'HEADER'),
      formatObservationIndex: mock((_obs: any, index: number) => `OBS-${index}`),
      formatSessionIndex: mock((_session: any, index: number) => `SESSION-${index}`),
      formatUserPromptIndex: mock((_prompt: any, index: number) => `PROMPT-${index}`),
      formatSearchTableHeader: mock(() => 'SEARCH-HEADER'),
      formatObservationSearchRow: mock(() => 'OBS-ROW'),
      formatSessionSearchRow: mock(() => 'SESSION-ROW'),
      formatUserPromptSearchRow: mock(() => 'PROMPT-ROW')
    } as any,
    {} as any
  );

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

  it('surfaces backend-not-ready state instead of pretending there were no results', async () => {
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
          notReady: true,
          message: 'sqlite-vec backend not ready yet.',
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

    expect(text).toContain('sqlite-vec backend not ready yet.');
    expect(text).not.toContain('No results found');
  });

  it('scopes searchObservations semantic queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));

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
      { queryChroma } as any,
      {} as any,
      {} as any
    );

    await manager.searchObservations({ query: 'matching', project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'matching',
      100,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });

  it('scopes concept ranking queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      notReady: true,
      message: 'sqlite-vec backend not ready yet.',
      ids: [],
      distances: [],
      metadatas: []
    }));

    const manager = buildManager(
      queryChroma,
      {
        findByConcept: mock(() => [
          {
            id: 2,
            memory_session_id: 'session-456',
            project: 'project-b',
            text: 'Vector note',
            type: 'decision',
            title: 'Vector note',
            subtitle: null,
            facts: '[]',
            narrative: 'Vector note',
            concepts: '["vector"]',
            files_read: '[]',
            files_modified: '[]',
            prompt_number: 1,
            discovery_tokens: 0,
            created_at: '2025-01-01T12:00:00.000Z',
            created_at_epoch: Date.now()
          }
        ])
      }
    );

    await manager.findByConcept({ concepts: 'vector', project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      ['vector'],
      1,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });

  it('falls back to metadata concept results when the vector backend is temporarily not ready', async () => {
    const queryChroma = mock(() => Promise.resolve({
      notReady: true,
      message: 'sqlite-vec backend not ready yet.',
      ids: [],
      distances: [],
      metadatas: []
    }));

    const manager = buildManager(
      queryChroma,
      {
        findByConcept: mock(() => [
          {
            id: 2,
            memory_session_id: 'session-456',
            project: 'project-b',
            text: 'Vector note',
            type: 'decision',
            title: 'Vector note',
            subtitle: null,
            facts: '[]',
            narrative: 'Vector note',
            concepts: '["vector"]',
            files_read: '[]',
            files_modified: '[]',
            prompt_number: 1,
            discovery_tokens: 0,
            created_at: '2025-01-01T12:00:00.000Z',
            created_at_epoch: Date.now()
          }
        ])
      }
    );

    const result = await manager.findByConcept({ concepts: 'vector', project: 'project-b' });
    const text = result.content[0].text;

    expect(text).toContain('Found 1 observation(s) with concept "vector"');
    expect(text).toContain('OBS-0');
    expect(text).not.toContain('backend not ready');
  });

  it('scopes timeline semantic queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));
    const manager = buildManager(queryChroma);

    await manager.timeline({ query: 'matching', project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'matching',
      100,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });

  it('scopes decision semantic queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));
    const manager = buildManager(queryChroma);

    await manager.decisions({ query: 'matching', project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'matching',
      40,
      { $and: [{ doc_type: 'observation', type: 'decision' }, { project: 'project-b' }] }
    );
  });

  it('scopes decision ranking queries without a free-text query to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));
    const manager = buildManager(queryChroma, {
      findByType: mock(() => [{
        id: 2,
        memory_session_id: 'session-456',
        project: 'project-b',
        text: 'Vector note',
        type: 'decision',
        title: 'Vector note',
        subtitle: null,
        facts: '[]',
        narrative: 'Vector note',
        concepts: '["vector"]',
        files_read: '[]',
        files_modified: '[]',
        prompt_number: 1,
        discovery_tokens: 0,
        created_at: '2025-01-01T12:00:00.000Z',
        created_at_epoch: Date.now()
      }])
    });

    await manager.decisions({ project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'decision',
      1,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });

  it('scopes change ranking queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));
    const matchingObservation = {
      id: 2,
      memory_session_id: 'session-456',
      project: 'project-b',
      text: 'Vector note',
      type: 'change',
      title: 'Vector note',
      subtitle: null,
      facts: '[]',
      narrative: 'Vector note',
      concepts: '["change"]',
      files_read: '[]',
      files_modified: '[]',
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: '2025-01-01T12:00:00.000Z',
      created_at_epoch: Date.now()
    };
    const manager = buildManager(queryChroma, {
      findByType: mock(() => [matchingObservation]),
      findByConcept: mock(() => [])
    });

    await manager.changes({ project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'what changed',
      1,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });

  it('scopes how-it-works ranking queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));
    const manager = buildManager(queryChroma, {
      findByConcept: mock(() => [{
        id: 2,
        memory_session_id: 'session-456',
        project: 'project-b',
        text: 'Vector note',
        type: 'decision',
        title: 'Vector note',
        subtitle: null,
        facts: '[]',
        narrative: 'Vector note',
        concepts: '["how-it-works"]',
        files_read: '[]',
        files_modified: '[]',
        prompt_number: 1,
        discovery_tokens: 0,
        created_at: '2025-01-01T12:00:00.000Z',
        created_at_epoch: Date.now()
      }])
    });

    await manager.howItWorks({ project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'how it works architecture',
      1,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });

  it('scopes getTimelineByQuery semantic queries to the requested project', async () => {
    const queryChroma = mock(() => Promise.resolve({
      ids: [],
      distances: [],
      metadatas: []
    }));
    const manager = buildManager(queryChroma);

    await manager.getTimelineByQuery({ query: 'matching', project: 'project-b' });

    expect(queryChroma).toHaveBeenCalledWith(
      'matching',
      100,
      { $and: [{ doc_type: 'observation' }, { project: 'project-b' }] }
    );
  });
});
