import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveOpaqueWorkspaceId,
  generateCapabilityToken,
  verifyCapabilityToken,
} from '../src/context/trusted-crypto.js';

describe('trusted crypto', () => {
  it('derives stable, opaque, domain-separated workspace IDs', () => {
    const key = Buffer.alloc(32, 7);
    const path = '/Users/example/project';
    const id = deriveOpaqueWorkspaceId(path, key);

    expect(id).toMatch(/^lfw1_[0-9a-f]{64}$/);
    expect(id).toBe(deriveOpaqueWorkspaceId(path, key));
    expect(id).not.toContain(path);
    expect(id).not.toBe(deriveOpaqueWorkspaceId(`${path}/other`, key));
    expect(id).not.toBe(`lfw1_${createHash('sha256').update(path).digest('hex')}`);
  });

  it('generates and verifies 256-bit capability tokens', () => {
    const token = generateCapabilityToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyCapabilityToken(token, token)).toBe(true);
    const altered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect(verifyCapabilityToken(token, altered)).toBe(false);
    expect(verifyCapabilityToken(token, token.slice(0, -2))).toBe(false);
  });
});