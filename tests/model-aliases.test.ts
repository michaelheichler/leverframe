import { describe, expect, it } from 'vitest';
import {
  InvalidModelAliasConfigurationError,
  ModelAliasCollisionError,
  normalizeModelAliases,
  parseModelAliasAssignment,
} from '../src/model-aliases.js';

describe('model alias canonicalization', () => {
  it('lowercases the alias name without changing its provider or model target', () => {
    expect(parseModelAliasAssignment(
      ' Kimi3-KCP = leverframe:Kimi:k3[1m]',
    )).toEqual({
      name: 'kimi3-kcp',
      providerId: 'Kimi',
      modelId: 'k3',
    });
  });

  it('normalizes every saved alias without changing target identifiers', () => {
    expect(normalizeModelAliases([
      { name: 'Kimi3-KCP', providerId: 'kimi', modelId: 'k3' },
      { name: 'GPT-5.6-Sol', providerId: 'OpenAI-OAuth', modelId: 'GPT-5.6-Sol' },
    ])).toEqual([
      { name: 'kimi3-kcp', providerId: 'kimi', modelId: 'k3' },
      { name: 'gpt-5.6-sol', providerId: 'OpenAI-OAuth', modelId: 'GPT-5.6-Sol' },
    ]);
  });

  it('rejects aliases that collide after lowercase normalization', () => {
    expect(() => normalizeModelAliases([
      { name: 'Kimi3-KCP', providerId: 'kimi', modelId: 'k3' },
      { name: 'kimi3-kcp', providerId: 'github-copilot', modelId: 'kimi-k3' },
    ])).toThrow(ModelAliasCollisionError);
  });

  it('rejects malformed external alias entries with a specific error', () => {
    let thrown: unknown;
    try {
      normalizeModelAliases([{ name: 42, providerId: 'kimi', modelId: 'k3' }]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidModelAliasConfigurationError);
    expect((thrown as Error).message).toContain('entry 1');
  });
});
