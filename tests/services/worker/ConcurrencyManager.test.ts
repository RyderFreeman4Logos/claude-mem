import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConcurrencyManager } from '../../../src/services/worker/ConcurrencyManager.js';

describe('ConcurrencyManager', () => {
  let tempDir: string;
  let settingsPath: string;
  let manager: ConcurrencyManager;

  beforeEach(() => {
    tempDir = join(tmpdir(), `concurrency-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    settingsPath = join(tempDir, 'settings.json');

    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_CONCURRENT_MESSAGES: '3',
    }, null, 2));

    manager = new ConcurrencyManager(settingsPath);
  });

  afterEach(() => {
    manager?.stopWatching();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('reloads desired concurrency after settings.json changes', async () => {
    manager.startWatching();

    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_CONCURRENT_MESSAGES: '5',
    }, null, 2));

    await new Promise((resolve) => setTimeout(resolve, 1200));

    expect(manager.getDesiredConcurrency()).toBe(5);
  });
});
