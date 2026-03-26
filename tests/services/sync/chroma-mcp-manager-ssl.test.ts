/**
 * Regression tests for SSL flag handling (PR #1286).
 *
 * Two test suites cover both the fork's SSE-based architecture and the
 * upstream stdio-based architecture:
 *
 * 1. ChromaServerLifecycle (fork/SSE) - validates buildChromaArgs() directly
 * 2. ChromaMcpManager (upstream/stdio) - validates via mocked StdioClientTransport
 *
 * Both suites verify: remote mode always forwards `--ssl <true|false>`,
 * while local mode omits the flag entirely.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ChromaServerLifecycle } from '../../../src/services/sync/ChromaServerLifecycle.js';

// ═══════════════════════════════════════════════════════════════════════
// Suite 1: ChromaServerLifecycle (fork SSE transport)
// ═══════════════════════════════════════════════════════════════════════

type SettingsLike = Record<string, string>;

function buildArgs(overrides: SettingsLike = {}): string[] {
  const lifecycle = new ChromaServerLifecycle();
  const settings: SettingsLike = {
    CLAUDE_MEM_CHROMA_MODE: 'remote',
    CLAUDE_MEM_CHROMA_HOST: '127.0.0.1',
    CLAUDE_MEM_CHROMA_PORT: '8000',
    CLAUDE_MEM_CHROMA_SSL: 'false',
    CLAUDE_MEM_CHROMA_TENANT: 'default_tenant',
    CLAUDE_MEM_CHROMA_DATABASE: 'default_database',
    CLAUDE_MEM_CHROMA_API_KEY: '',
    ...overrides,
  };

  return (lifecycle as unknown as {
    buildChromaArgs: (input: SettingsLike) => string[];
  }).buildChromaArgs(settings);
}

describe('ChromaServerLifecycle SSL flag regression (#1286)', () => {
  it('emits --ssl false when CLAUDE_MEM_CHROMA_SSL=false', () => {
    const args = buildArgs({ CLAUDE_MEM_CHROMA_SSL: 'false' });
    const sslIdx = args.indexOf('--ssl');
    expect(sslIdx).not.toBe(-1);
    expect(args[sslIdx + 1]).toBe('false');
  });

  it('emits --ssl true when CLAUDE_MEM_CHROMA_SSL=true', () => {
    const args = buildArgs({ CLAUDE_MEM_CHROMA_SSL: 'true' });
    const sslIdx = args.indexOf('--ssl');
    expect(sslIdx).not.toBe(-1);
    expect(args[sslIdx + 1]).toBe('true');
  });

  it('defaults --ssl false when CLAUDE_MEM_CHROMA_SSL is not set', () => {
    const args = buildArgs({ CLAUDE_MEM_CHROMA_SSL: '' });
    const sslIdx = args.indexOf('--ssl');
    expect(sslIdx).not.toBe(-1);
    expect(args[sslIdx + 1]).toBe('false');
  });

  it('omits --ssl entirely in local mode', () => {
    const args = buildArgs({ CLAUDE_MEM_CHROMA_MODE: 'local' });
    expect(args).not.toContain('--ssl');
    expect(args).toContain('--client-type');
    expect(args[args.indexOf('--client-type') + 1]).toBe('persistent');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 2: ChromaMcpManager (upstream stdio transport)
// ═══════════════════════════════════════════════════════════════════════

// ── Mutable settings closure (updated per test) ────────────────────────
let currentSettings: Record<string, string> = {};

// ── Mock modules BEFORE importing the module under test ────────────────
// Capture the args passed to StdioClientTransport constructor
let capturedTransportOpts: { command: string; args: string[] } | null = null;

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class FakeTransport {
    // Required: ChromaMcpManager assigns transport.onclose after connect()
    onclose: (() => void) | null = null;
    constructor(opts: { command: string; args: string[] }) {
      capturedTransportOpts = { command: opts.command, args: opts.args };
    }
    async close() {}
  },
}));

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class FakeClient {
    constructor() {}
    async connect() {}
    async callTool() {
      return { content: [{ type: 'text', text: '{}' }] };
    }
    async close() {}
  },
}));

mock.module('../../../src/shared/SettingsDefaultsManager.js', () => ({
  SettingsDefaultsManager: {
    get: (key: string) => currentSettings[key] ?? '',
    getInt: () => 0,
    loadFromFile: () => currentSettings,
  },
}));

mock.module('../../../src/shared/paths.js', () => ({
  USER_SETTINGS_PATH: '/tmp/fake-settings.json',
}));

mock.module('../../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    failure: () => {},
  },
}));

// ── Now import the module under test ───────────────────────────────────
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';

// ── Helpers ────────────────────────────────────────────────────────────
async function assertSslFlag(sslSetting: string | undefined, expectedValue: string) {
  currentSettings = { CLAUDE_MEM_CHROMA_MODE: 'remote' };
  if (sslSetting !== undefined) currentSettings.CLAUDE_MEM_CHROMA_SSL = sslSetting;

  await mgr.callTool('chroma_list_collections', {});

  expect(capturedTransportOpts).not.toBeNull();
  const sslIdx = capturedTransportOpts!.args.indexOf('--ssl');
  expect(sslIdx).not.toBe(-1);
  expect(capturedTransportOpts!.args[sslIdx + 1]).toBe(expectedValue);
}

let mgr: ChromaMcpManager;

// ── Test suite ─────────────────────────────────────────────────────────
describe('ChromaMcpManager SSL flag regression (#1286)', () => {
  beforeEach(async () => {
    await ChromaMcpManager.reset();
    capturedTransportOpts = null;
    currentSettings = {};
    mgr = ChromaMcpManager.getInstance();
  });

  it('emits --ssl false when CLAUDE_MEM_CHROMA_SSL=false', async () => {
    await assertSslFlag('false', 'false');
  });

  it('emits --ssl true when CLAUDE_MEM_CHROMA_SSL=true', async () => {
    await assertSslFlag('true', 'true');
  });

  it('defaults --ssl false when CLAUDE_MEM_CHROMA_SSL is not set', async () => {
    await assertSslFlag(undefined, 'false');
  });

  it('omits --ssl entirely in local mode', async () => {
    currentSettings = {
      CLAUDE_MEM_CHROMA_MODE: 'local',
    };

    await mgr.callTool('chroma_list_collections', {});

    expect(capturedTransportOpts).not.toBeNull();
    const args = capturedTransportOpts!.args;
    expect(args).not.toContain('--ssl');
    expect(args).toContain('--client-type');
    expect(args[args.indexOf('--client-type') + 1]).toBe('persistent');
  });
});
