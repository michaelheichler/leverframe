import { createHash } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from '../atomic-file.js';
import { getAppHome } from '../paths.js';
import { AntigravityError, objectRecord } from './types.js';

function latchPath(accountId: string): string {
  if (!accountId) throw new AntigravityError('Antigravity billing account is missing.', 401);
  const hash = createHash('sha256').update(accountId).digest('hex');
  return join(getAppHome(), 'antigravity', 'billing', `${hash}.json`);
}

export function assertAntigravityBillingAllowed(accountId: string): void {
  try {
    lstatSync(latchPath(accountId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AntigravityError('Antigravity billing state is unreadable. Review it before signing in again.', 409, 'BILLING_POLICY');
  }
  throw new AntigravityError('Antigravity reported credit consumption. Requests are blocked until you review billing and sign in again.', 409, 'BILLING_POLICY');
}

function creditsRequireBlock(value: unknown): boolean {
  if (typeof value === 'number') return value !== 0;
  if (!Array.isArray(value)) return true;
  return value.some(credit => {
    const amount = objectRecord(credit)?.creditAmount;
    return (typeof amount !== 'number' && typeof amount !== 'string') || !Number.isFinite(Number(amount)) || Number(amount) !== 0;
  });
}

export function recordAntigravityCreditConsumption(accountId: string, payload: unknown): void {
  const record = objectRecord(payload);
  if (!record) return;
  const field = 'consumedCredits' in record ? 'consumedCredits' : 'consumed_credits' in record ? 'consumed_credits' : undefined;
  if (!field || !creditsRequireBlock(record[field])) return;
  atomicWriteJsonSync(latchPath(accountId), { blocked: true, detectedAt: new Date().toISOString() }, { mode: 0o600, directoryMode: 0o700 });
}

export function clearAntigravityBillingLatch(accountId: string): void {
  try {
    unlinkSync(latchPath(accountId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
