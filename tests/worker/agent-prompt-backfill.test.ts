import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SDKAgent } from '../../src/services/worker/SDKAgent';
import { GeminiAgent } from '../../src/services/worker/GeminiAgent';
import { OpenRouterAgent } from '../../src/services/worker/OpenRouterAgent';
import { logger } from '../../src/utils/logger.js';

describe('agent prompt backfill', () => {
  let loggerSpies: ReturnType<typeof spyOn>[];

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  function createSessionStoreMock(prompts: Array<{ id: number; prompt_number: number; prompt_text: string; created_at_epoch: number }>) {
    return {
      updateMemorySessionId: mock(() => {}),
      ensureMemorySessionIdRegistered: mock(() => {}),
      getSessionById: mock(() => ({ memory_session_id: 'captured-memory-session' })),
      getUnsyncedUserPromptsByContentSessionId: mock(() => prompts.map(prompt => ({
        ...prompt,
        content_session_id: 'content-session-1',
        created_at: new Date(prompt.created_at_epoch).toISOString(),
        vector_synced_at: null
      }))),
      markPromptVectorSynced: mock(() => {})
    };
  }

  function createVectorSyncMock() {
    return {
      backend: 'sqlite-vec' as const,
      syncUserPrompt: mock(async () => {})
    };
  }

  it('SDKAgent backfills every un-synced prompt after memory session capture', async () => {
    const prompt1 = { id: 11, prompt_number: 1, prompt_text: 'First prompt', created_at_epoch: Date.now() - 10 };
    const prompt2 = { id: 12, prompt_number: 2, prompt_text: 'Second prompt before first response', created_at_epoch: Date.now() - 5 };
    const sessionStore = createSessionStoreMock([prompt1, prompt2]);
    const vectorSync = createVectorSyncMock();
    const sessionManager = {
      syncMemorySessionId: mock(() => {})
    } as any;
    const dbManager = {
      getSessionStore: () => sessionStore,
      getVectorSync: () => vectorSync
    } as any;
    const agent = new SDKAgent(dbManager, sessionManager);
    const session = {
      sessionDbId: 1,
      contentSessionId: 'content-session-1',
      memorySessionId: null,
      project: 'test-project'
    } as any;

    await (agent as any).registerCapturedMemorySessionId(session, 'captured-memory-session');

    expect(sessionManager.syncMemorySessionId).toHaveBeenCalledWith(1, 'captured-memory-session');
    expect(sessionStore.ensureMemorySessionIdRegistered).toHaveBeenCalledWith(1, 'captured-memory-session');
    expect(vectorSync.syncUserPrompt).toHaveBeenNthCalledWith(
      1,
      prompt1.id,
      'captured-memory-session',
      'test-project',
      prompt1.prompt_text,
      prompt1.prompt_number,
      prompt1.created_at_epoch
    );
    expect(vectorSync.syncUserPrompt).toHaveBeenNthCalledWith(
      2,
      prompt2.id,
      'captured-memory-session',
      'test-project',
      prompt2.prompt_text,
      prompt2.prompt_number,
      prompt2.created_at_epoch
    );
    expect(sessionStore.markPromptVectorSynced).toHaveBeenCalledTimes(2);
  });

  it('GeminiAgent backfills prompts after generating its synthetic memory session id', async () => {
    const prompt = { id: 21, prompt_number: 1, prompt_text: 'Gemini prompt', created_at_epoch: Date.now() };
    const sessionStore = createSessionStoreMock([prompt]);
    const vectorSync = createVectorSyncMock();
    const dbManager = {
      getSessionStore: () => sessionStore,
      getVectorSync: () => vectorSync
    } as any;
    const agent = new GeminiAgent(dbManager, {} as any);
    const session = {
      contentSessionId: 'content-session-1',
      project: 'test-project'
    } as any;

    await (agent as any).backfillPromptsAfterMemoryCapture(session, 'gemini-content-session-1-123');

    expect(sessionStore.getUnsyncedUserPromptsByContentSessionId).toHaveBeenCalledWith('content-session-1');
    expect(vectorSync.syncUserPrompt).toHaveBeenCalledWith(
      prompt.id,
      'gemini-content-session-1-123',
      'test-project',
      prompt.prompt_text,
      prompt.prompt_number,
      prompt.created_at_epoch
    );
    expect(sessionStore.markPromptVectorSynced).toHaveBeenCalledTimes(1);
  });

  it('OpenRouterAgent backfills prompts after generating its synthetic memory session id', async () => {
    const prompt = { id: 31, prompt_number: 1, prompt_text: 'OpenRouter prompt', created_at_epoch: Date.now() };
    const sessionStore = createSessionStoreMock([prompt]);
    const vectorSync = createVectorSyncMock();
    const dbManager = {
      getSessionStore: () => sessionStore,
      getVectorSync: () => vectorSync
    } as any;
    const agent = new OpenRouterAgent(dbManager, {} as any);
    const session = {
      contentSessionId: 'content-session-1',
      project: 'test-project'
    } as any;

    await (agent as any).backfillPromptsAfterMemoryCapture(session, 'openrouter-content-session-1-123');

    expect(sessionStore.getUnsyncedUserPromptsByContentSessionId).toHaveBeenCalledWith('content-session-1');
    expect(vectorSync.syncUserPrompt).toHaveBeenCalledWith(
      prompt.id,
      'openrouter-content-session-1-123',
      'test-project',
      prompt.prompt_text,
      prompt.prompt_number,
      prompt.created_at_epoch
    );
    expect(sessionStore.markPromptVectorSynced).toHaveBeenCalledTimes(1);
  });
});
