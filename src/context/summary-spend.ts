import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { withConfigWriteLock } from '../config-lock.js';
import { durableAtomicWrite, readFileStrict } from '../durable-io.js';
import { getAppHome } from '../paths.js';

interface Ledger { reservations: Record<string, number>; settledMicros: number }

function validAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function readLedger(path: string): Ledger {
  if (!existsSync(path)) return { reservations: {}, settledMicros: 0 };
  const ledger = JSON.parse(readFileStrict(path, { requirePrivateMode: true, maxBytes: 2_000_000 })) as Ledger;
  if (!ledger || typeof ledger !== 'object' || !validAmount(ledger.settledMicros) || !ledger.reservations || typeof ledger.reservations !== 'object' || Array.isArray(ledger.reservations) || !Object.values(ledger.reservations).every(validAmount)) throw new Error('invalid summary ledger');
  return ledger;
}

function updateLedger<T>(operation: (ledger: Ledger) => T): T {
  return withConfigWriteLock(() => {
    const path = join(getAppHome(), 'summary-spend.json');
    const ledger = readLedger(path);
    const result = operation(ledger);
    durableAtomicWrite(path, `${JSON.stringify(ledger)}\n`);
    return result;
  });
}

export function reserveSummarySpend(input: { limitMicros: number; maximumMicros: number; authorize?: () => boolean }): string | undefined {
  if (!validAmount(input.limitMicros) || input.limitMicros === 0 || !validAmount(input.maximumMicros)) return undefined;
  return updateLedger(ledger => {
    if (input.authorize && !input.authorize()) return undefined;
    const total = Object.values(ledger.reservations).reduce((sum, value) => sum + value, ledger.settledMicros);
    if (!Number.isSafeInteger(total) || total >= input.limitMicros || input.maximumMicros > input.limitMicros - total) return undefined;
    const id = randomUUID();
    ledger.reservations[id] = input.maximumMicros;
    return id;
  });
}

export function settleSummarySpend(id: string, actualMicros?: number): void {
  updateLedger(ledger => {
    const reserved = ledger.reservations[id];
    if (reserved === undefined) throw new Error('unknown summary reservation');
    const charge = validAmount(actualMicros) && actualMicros <= reserved ? actualMicros : reserved;
    if (!Number.isSafeInteger(ledger.settledMicros + charge)) throw new Error('summary ledger overflow');
    ledger.settledMicros += charge;
    delete ledger.reservations[id];
  });
}
