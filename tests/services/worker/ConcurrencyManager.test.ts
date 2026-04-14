import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConcurrencyManager } from '../../../src/services/worker/ConcurrencyManager.js';
import { logger } from '../../../src/utils/logger.js';

describe('ConcurrencyManager', () => {
  let tempDir: string;
  let settingsPath: string;
  let manager: ConcurrencyManager;
  let loggerInfoSpy: ReturnType<typeof spyOn>;
  let originalConcurrentMessagesEnv: string | undefined;

  beforeEach(() => {
    originalConcurrentMessagesEnv = process.env.CLAUDE_MEM_CONCURRENT_MESSAGES;
    delete process.env.CLAUDE_MEM_CONCURRENT_MESSAGES;

    tempDir = join(process.cwd(), `.tmp-concurrency-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');

    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_CONCURRENT_MESSAGES: '3',
    }, null, 2));

    manager = new ConcurrencyManager(settingsPath);
    loggerInfoSpy = spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    manager?.stopWatching();
    loggerInfoSpy?.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });

    if (originalConcurrentMessagesEnv === undefined) {
      delete process.env.CLAUDE_MEM_CONCURRENT_MESSAGES;
    } else {
      process.env.CLAUDE_MEM_CONCURRENT_MESSAGES = originalConcurrentMessagesEnv;
    }
  });

  test('reloads desired concurrency after settings.json changes', async () => {
    manager.startWatching();
    await new Promise((resolve) => setTimeout(resolve, 50));

    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_CONCURRENT_MESSAGES: '5',
    }, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(manager.getDesiredConcurrency()).toBe(5);
  });

  test('reloads after atomic rename and logs the applied change once', async () => {
    manager.startWatching();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const replacementPath = join(tempDir, 'settings.json.tmp');
    writeFileSync(replacementPath, JSON.stringify({
      CLAUDE_MEM_CONCURRENT_MESSAGES: '7',
    }, null, 2));
    renameSync(replacementPath, settingsPath);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(manager.getDesiredConcurrency()).toBe(7);
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      'SYSTEM',
      'ConcurrencyManager reloaded desired worker concurrency from settings',
      expect.objectContaining({
        from: 3,
        to: 7,
        settingsPath,
        eventType: 'rename'
      })
    );
  });
});
