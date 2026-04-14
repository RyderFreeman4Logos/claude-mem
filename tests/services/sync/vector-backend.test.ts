import { describe, expect, it } from 'bun:test';
import type { SettingsDefaults } from '../../../src/shared/SettingsDefaultsManager.js';
import { resolveVectorBackend } from '../../../src/services/sync/VectorBackend.js';

function makeSettings(overrides: Partial<SettingsDefaults> = {}): SettingsDefaults {
  return {
    CLAUDE_MEM_VECTOR_BACKEND: 'chroma',
    CLAUDE_MEM_CHROMA_ENABLED: 'true',
    ...overrides
  } as SettingsDefaults;
}

describe('resolveVectorBackend', () => {
  it('defaults to chroma when no override is set', () => {
    const settings = makeSettings();

    expect(resolveVectorBackend(settings)).toBe('chroma');
  });

  it('uses sqlite-vec when explicitly configured', () => {
    const settings = makeSettings({ CLAUDE_MEM_VECTOR_BACKEND: 'sqlite-vec' });

    expect(resolveVectorBackend(settings)).toBe('sqlite-vec');
  });

  it('preserves legacy disable semantics when chroma is disabled', () => {
    const settings = makeSettings({ CLAUDE_MEM_CHROMA_ENABLED: 'false' });

    expect(resolveVectorBackend(settings)).toBe('disabled');
  });

  it('treats an empty backend override as default chroma selection', () => {
    const settings = makeSettings({ CLAUDE_MEM_VECTOR_BACKEND: '' });

    expect(resolveVectorBackend(settings)).toBe('chroma');
  });
});
