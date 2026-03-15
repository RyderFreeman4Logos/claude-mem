/**
 * Regression tests for Chroma SSE server SSL flag handling (PR #1286).
 *
 * In this fork the remote/local Chroma CLI arguments are built by
 * ChromaServerLifecycle, not ChromaMcpManager. The behavior should still match
 * upstream: remote mode always forwards `--ssl <true|false>`, while local mode
 * omits the flag entirely.
 */
import { describe, it, expect } from 'bun:test';
import { ChromaServerLifecycle } from '../../../src/services/sync/ChromaServerLifecycle.js';

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
