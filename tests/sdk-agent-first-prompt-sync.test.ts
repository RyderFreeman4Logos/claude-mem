import { describe, expect, it, mock } from 'bun:test';
import { SDKAgent } from '../src/services/worker/SDKAgent.js';

describe('SDKAgent first prompt sync backfill', () => {
  it('backfills the latest prompt after capturing the first memory session id', async () => {
    const syncUserPrompt = mock(async () => {});
    const dbManager = {
      getSessionStore: () => ({
        getLatestUserPrompt: () => ({
          id: 17,
          content_session_id: 'content-session-1',
          memory_session_id: null,
          project: 'test-project',
          prompt_number: 1,
          prompt_text: 'Investigate vector backend routing',
          created_at: new Date(1700000000000).toISOString(),
          created_at_epoch: 1700000000,
        })
      }),
      getVectorSync: () => ({
        syncUserPrompt
      })
    } as any;

    const agent = new SDKAgent(dbManager, {} as any);

    await (agent as any).syncLatestPromptAfterMemoryCapture('content-session-1', 'memory-session-1');

    expect(syncUserPrompt).toHaveBeenCalledWith(
      17,
      'memory-session-1',
      'test-project',
      'Investigate vector backend routing',
      1,
      1700000000
    );
  });

  it('does nothing when there is no prompt or vector backend to backfill', async () => {
    const syncUserPrompt = mock(async () => {});
    const agentWithoutPrompt = new SDKAgent({
      getSessionStore: () => ({
        getLatestUserPrompt: () => undefined
      }),
      getVectorSync: () => ({
        syncUserPrompt
      })
    } as any, {} as any);

    await (agentWithoutPrompt as any).syncLatestPromptAfterMemoryCapture('content-session-1', 'memory-session-1');

    const agentWithoutBackend = new SDKAgent({
      getSessionStore: () => ({
        getLatestUserPrompt: () => ({
          id: 17,
          content_session_id: 'content-session-1',
          memory_session_id: null,
          project: 'test-project',
          prompt_number: 1,
          prompt_text: 'Investigate vector backend routing',
          created_at: new Date(1700000000000).toISOString(),
          created_at_epoch: 1700000000,
        })
      }),
      getVectorSync: () => null
    } as any, {} as any);

    await (agentWithoutBackend as any).syncLatestPromptAfterMemoryCapture('content-session-1', 'memory-session-1');

    expect(syncUserPrompt).not.toHaveBeenCalled();
  });
});
