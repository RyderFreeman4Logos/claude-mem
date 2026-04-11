import { afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const TEST_ROOT = join(
  process.platform === 'win32' ? process.cwd() : '/tmp',
  `claude-mem-bun-test-${process.pid}`
);
const TEST_HOME = join(TEST_ROOT, 'home');
const TEST_TMP = join(TEST_ROOT, 'tmp');
const TEST_CLAUDE_CONFIG = join(TEST_HOME, '.claude');
const TEST_DATA_DIR = join(TEST_HOME, '.claude-mem');

for (const dir of [TEST_HOME, TEST_TMP, TEST_CLAUDE_CONFIG, TEST_DATA_DIR]) {
  mkdirSync(dir, { recursive: true });
}

process.env.HOME = TEST_HOME;
process.env.CLAUDE_CONFIG_DIR = TEST_CLAUDE_CONFIG;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;
process.env.TMPDIR = TEST_TMP;
process.env.TMP = TEST_TMP;
process.env.TEMP = TEST_TMP;

if (process.platform === 'win32') {
  process.env.USERPROFILE = TEST_HOME;
}

const cleanupTestRoot = () => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
};

process.on('exit', cleanupTestRoot);

afterEach(async () => {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[SETTINGS] All caches cleared')) {
      return;
    }

    originalConsoleError(...args);
  };

  try {
    const { SettingsDefaultsManager } = await import('../src/shared/SettingsDefaultsManager.js');
    if (typeof SettingsDefaultsManager.clearCache === 'function') {
      SettingsDefaultsManager.clearCache();
    }
  } finally {
    console.error = originalConsoleError;
  }
});
