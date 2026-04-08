import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { logger } from '../../src/utils/logger.js';

type PendingResponse = {
  resolve: (value: { ok: boolean }) => void;
};

const requests: Array<{ apiPath: string; options?: RequestInit & { timeoutMs?: number } }> = [];
let ensureWorkerReady = true;
let extractedMessage = 'Final assistant response';
let summarizeResponseOk = true;
let pendingCompleteResponse: PendingResponse | null = null;
let completeRequestError: Error | null = null;

mock.module('../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: () => Promise.resolve(ensureWorkerReady),
  workerHttpRequest: (apiPath: string, options?: RequestInit & { timeoutMs?: number }) => {
    requests.push({ apiPath, options });

    if (apiPath === '/api/sessions/summarize') {
      return Promise.resolve({ ok: summarizeResponseOk });
    }

    if (apiPath === '/api/sessions/complete') {
      if (completeRequestError) {
        return Promise.reject(completeRequestError);
      }
      return new Promise<{ ok: boolean }>((resolve) => {
        pendingCompleteResponse = { resolve };
      });
    }

    throw new Error(`Unexpected worker request: ${apiPath}`);
  },
}));

mock.module('../../src/shared/transcript-parser.js', () => ({
  extractLastMessage: () => extractedMessage,
}));

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  requests.length = 0;
  ensureWorkerReady = true;
  extractedMessage = 'Final assistant response';
  summarizeResponseOk = true;
  pendingCompleteResponse = null;
  completeRequestError = null;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'dataIn').mockImplementation(() => {}),
  ];
});

afterEach(async () => {
  pendingCompleteResponse?.resolve({ ok: true });
  pendingCompleteResponse = null;
  await Promise.resolve();
  loggerSpies.forEach((spy) => spy.mockRestore());
});

describe('summarizeHandler', () => {
  it('queues summarize work and fires session completion without waiting for it', async () => {
    const { summarizeHandler } = await import('../../src/cli/handlers/summarize.js');

    const result = await Promise.race([
      summarizeHandler.execute({
        sessionId: 'content-session-1',
        transcriptPath: '/tmp/transcript.json',
        cwd: '/tmp/project',
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);

    expect(result).not.toBe('timeout');
    expect(result).toEqual({ continue: true, suppressOutput: true });

    const summarizeRequest = requests.find(({ apiPath }) => apiPath === '/api/sessions/summarize');
    const completeRequest = requests.find(({ apiPath }) => apiPath === '/api/sessions/complete');

    expect(summarizeRequest).toBeDefined();
    expect(completeRequest).toBeDefined();
    expect(requests.some(({ apiPath }) => apiPath.startsWith('/api/sessions/status'))).toBe(false);
    expect(JSON.parse(String(summarizeRequest?.options?.body))).toEqual({
      contentSessionId: 'content-session-1',
      last_assistant_message: 'Final assistant response',
    });
    expect(JSON.parse(String(completeRequest?.options?.body))).toEqual({
      contentSessionId: 'content-session-1',
    });
    expect(pendingCompleteResponse).not.toBeNull();
  });

  it('skips queuing when the transcript has no assistant message', async () => {
    extractedMessage = '   ';

    const { summarizeHandler } = await import('../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'content-session-empty',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp/project',
    });

    expect(result).toEqual({ continue: true, suppressOutput: true, exitCode: 0 });
    expect(requests).toHaveLength(0);
  });

  it('returns early when queuing the summarize request fails', async () => {
    summarizeResponseOk = false;

    const { summarizeHandler } = await import('../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'content-session-failed-summary',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp/project',
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });
    expect(requests.map(({ apiPath }) => apiPath)).toEqual(['/api/sessions/summarize']);
    expect(pendingCompleteResponse).toBeNull();
  });

  it('logs and suppresses completion request failures without blocking the hook', async () => {
    completeRequestError = new Error('session complete failed');

    const { summarizeHandler } = await import('../../src/cli/handlers/summarize.js');
    const result = await summarizeHandler.execute({
      sessionId: 'content-session-complete-error',
      transcriptPath: '/tmp/transcript.json',
      cwd: '/tmp/project',
    });

    expect(result).toEqual({ continue: true, suppressOutput: true });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const warnSpy = loggerSpies[2];
    expect(warnSpy).toHaveBeenCalledWith(
      'HOOK',
      'Stop hook: session-complete failed: session complete failed',
    );
  });
});
