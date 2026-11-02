import { createHash, createHmac } from 'node:crypto';
import { join, resolve } from 'node:path';
import { getAppHome } from '../paths.js';
import { createEvidenceStore, type EvidenceStore } from './evidence-store.js';
import { readOrCreateWorkspaceDigestKey } from './workspace-digest-key.js';

export async function openEvidenceStore(): Promise<EvidenceStore> {
  const rawCap = process.env.LEVERFRAME_EVIDENCE_MAX_BYTES;
  const maxBytes = rawCap === undefined ? undefined : Number(rawCap);
  if (rawCap !== undefined && (!/^\d+$/.test(rawCap) || !Number.isSafeInteger(maxBytes) || maxBytes! <= 0)) throw new Error('invalid evidence cap');
  const home = resolve(getAppHome());
  const secret = await readOrCreateWorkspaceDigestKey();
  const key = createHmac('sha256', Buffer.from(secret.slice(3), 'hex')).update('leverframe:evidence:v1').digest();
  const workspaceId = createHash('sha256').update(home).digest('hex');
  return createEvidenceStore({ directory: join(home, 'evidence'), key, workspaceId, maxBytes });
}
