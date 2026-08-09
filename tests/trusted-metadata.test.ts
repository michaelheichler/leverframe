import { describe, expect, it } from 'vitest';
import {
  TRUSTED_METADATA_ENV,
  TRUSTED_METADATA_HEADERS,
  parseTrustedMetadataEnv,
  parseTrustedMetadataHeaders,
  serializeTrustedMetadata,
  verifyCapabilityToken,
} from '../src/context/trusted-metadata.js';

const metadata = {
  workspaceId: `lfw1_${'a'.repeat(64)}`,
  capabilityToken: 'b'.repeat(64),
  agentRole: 'subagent' as const,
  parentSessionId: 'parent_01',
  protocolVersion: '1' as const,
};

describe('trusted metadata', () => {
  it('serializes and parses only the allowlisted fields', () => {
    const encoded = serializeTrustedMetadata(metadata);

    expect(parseTrustedMetadataEnv(encoded.env)).toEqual(metadata);
    expect(parseTrustedMetadataHeaders(encoded.headers)).toEqual(metadata);
    expect(Object.keys(encoded.env)).toEqual(Object.values(TRUSTED_METADATA_ENV));
    expect(Object.keys(encoded.headers)).toEqual(Object.values(TRUSTED_METADATA_HEADERS));
  });

  it('rejects malformed and unbounded metadata', () => {
    expect(() => serializeTrustedMetadata({ ...metadata, workspaceId: '/private/workspace' })).toThrow();
    expect(() => parseTrustedMetadataHeaders({ ...serializeTrustedMetadata(metadata).headers, 'x-extra': 'x' })).toThrow();
    expect(() => parseTrustedMetadataEnv({ ...serializeTrustedMetadata(metadata).env, [TRUSTED_METADATA_ENV.capabilityToken]: 'short' })).toThrow();
  });

  it('verifies strictly formatted capability tokens', () => {
    expect(verifyCapabilityToken(metadata.capabilityToken, metadata.capabilityToken)).toBe(true);
    expect(verifyCapabilityToken(metadata.capabilityToken, 'c'.repeat(64))).toBe(false);
    expect(verifyCapabilityToken(metadata.capabilityToken, 'b'.repeat(63))).toBe(false);
    expect(verifyCapabilityToken('/private/workspace', metadata.capabilityToken)).toBe(false);
  });
});