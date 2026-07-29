import { describe, expect, it } from 'vitest';
import {
  buildProviderCapabilities,
  requireCapability,
  UnsupportedCapabilityError,
} from '../src/provider-capabilities.js';

describe('buildProviderCapabilities', () => {
  it('defaults everything unstated to false except recovery/client-state fallbacks', () => {
    const matrix = buildProviderCapabilities({});
    expect(matrix.streaming).toBe(false);
    expect(matrix.tools).toBe(false);
    expect(matrix.reasoning).toBe(false);
    expect(matrix.websocket).toBe(false);
    expect(matrix.nativeResume).toBe(false);
    // No native resume, but client-managed state defaults true -> reconstruction is available.
    expect(matrix.clientManagedState).toBe(true);
    expect(matrix.reconstructedRecovery).toBe(true);
    expect(matrix.checkpoints).toBe(true);
    expect(matrix.source).toBe('inferred');
  });

  it('turns on capabilities the supplier declares true', () => {
    const matrix = buildProviderCapabilities({
      providerId: 'anthropic',
      streaming: true,
      tools: true,
      images: true,
      reasoning: true,
      promptCache: true,
    });
    expect(matrix).toMatchObject({
      streaming: true,
      tools: true,
      images: true,
      reasoning: true,
      promptCache: true,
      source: 'supplier-metadata',
    });
  });

  it('explicit supplier reasoning:false wins over a widening local override', () => {
    const matrix = buildProviderCapabilities(
      { providerId: 'openrouter/model-x', reasoning: false },
      { 'openrouter/model-x': { reasoning: true } },
    );
    expect(matrix.reasoning).toBe(false);
  });

  it('explicit local-override false wins even if the supplier said true', () => {
    const matrix = buildProviderCapabilities(
      { providerId: 'quirky', tools: true },
      { quirky: { tools: false } },
    );
    expect(matrix.tools).toBe(false);
    expect(matrix.source).toBe('local-override');
  });

  it('derives reconstructedRecovery=false when neither native resume nor client-managed state is available', () => {
    const matrix = buildProviderCapabilities({
      providerId: 'opaque-server-state',
      nativeResume: false,
      clientManagedState: false,
    });
    expect(matrix.reconstructedRecovery).toBe(false);
    expect(matrix.checkpoints).toBe(false);
  });

  it('nativeResume true implies checkpoints are usable even without client-managed state', () => {
    const matrix = buildProviderCapabilities({
      providerId: 'server-resumable',
      nativeResume: true,
      clientManagedState: false,
    });
    expect(matrix.reconstructedRecovery).toBe(false);
    expect(matrix.checkpoints).toBe(true);
  });
});

describe('requireCapability', () => {
  it('passes silently when the capability is declared', () => {
    const matrix = buildProviderCapabilities({ streaming: true });
    expect(() => requireCapability({ matrix, capability: 'streaming' })).not.toThrow();
  });

  it('throws UnsupportedCapabilityError with the capability and provider id when missing', () => {
    const matrix = buildProviderCapabilities({ providerId: 'no-tools', tools: false });
    try {
      requireCapability({ matrix, capability: 'tools', providerId: 'no-tools' });
      expect.unreachable();
    } catch (err) {
      expect(UnsupportedCapabilityError.isInstance(err)).toBe(true);
      expect((err as UnsupportedCapabilityError).capability).toBe('tools');
      expect((err as UnsupportedCapabilityError).providerId).toBe('no-tools');
    }
  });
});
