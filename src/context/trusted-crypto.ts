import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertCanonicalWorkspacePath } from './trusted-metadata.js';

const WORKSPACE_DIGEST_KEY_BYTES = 32;
const WORKSPACE_ID_DOMAIN = 'leverframe:trusted-workspace-id:v1\0';
const CAPABILITY_TOKEN_BYTES = 32;
const CAPABILITY_TOKEN = /^[0-9a-f]{64}$/;

export function deriveOpaqueWorkspaceId(canonicalWorkspacePath: string, digestKey: Uint8Array): string {
  assertCanonicalWorkspacePath(canonicalWorkspacePath);
  if (digestKey.byteLength !== WORKSPACE_DIGEST_KEY_BYTES) throw new Error('workspace digest key is invalid');
  const digest = createHmac('sha256', digestKey)
    .update(WORKSPACE_ID_DOMAIN, 'utf8')
    .update(canonicalWorkspacePath, 'utf8')
    .digest('hex');
  return `lfw1_${digest}`;
}

export function generateCapabilityToken(): string {
  return randomBytes(CAPABILITY_TOKEN_BYTES).toString('hex');
}

export function verifyCapabilityToken(expected: string, supplied: string): boolean {
  if (!CAPABILITY_TOKEN.test(expected) || !CAPABILITY_TOKEN.test(supplied)) return false;
  return timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(supplied, 'ascii'));
}