import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { getAppHome } from '../src/paths.js';
import { reserveSummarySpend, settleSummarySpend } from '../src/context/summary-spend.js';

const runFile = promisify(execFile);
const temporaryHomes: string[] = [];
const originalHome = process.env['LEVERFRAME_HOME'];

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = originalHome;
  temporaryHomes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true }));
});

function isolatedLedgerHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-summary-spend-'));
  temporaryHomes.push(home);
  vi.stubEnv('LEVERFRAME_HOME', home);
  return home;
}

it('writes reservations under the explicit isolated app home', () => {
  const home = isolatedLedgerHome();
  expect(getAppHome()).toBe(home);
  const reservation = reserveSummarySpend({ limitMicros: 10, maximumMicros: 10 });
  expect(reservation).toBeTruthy();
  settleSummarySpend(reservation!, 3);
  expect(reserveSummarySpend({ limitMicros: 10, maximumMicros: 7 })).toBeTruthy();

  expect(existsSync(join(home, 'summary-spend.json'))).toBe(true);
});

it.each([
  { limitMicros: 0, maximumMicros: 1 },
  { limitMicros: 10, maximumMicros: 11 },
])('declines an invalid or unaffordable reservation', ({ limitMicros, maximumMicros }) => {
  isolatedLedgerHome();

  expect(reserveSummarySpend({ limitMicros, maximumMicros })).toBeUndefined();
});

it('does not reserve or charge when the current settings reject authorization', () => {
  isolatedLedgerHome();

  expect(reserveSummarySpend({ limitMicros: 100, maximumMicros: 60, authorize: () => false })).toBeUndefined();
  expect(reserveSummarySpend({ limitMicros: 100, maximumMicros: 100 })).toBeTruthy();
});

it('settles the actual charge and makes only the unused reservation available again', () => {
  isolatedLedgerHome();
  const firstReservation = reserveSummarySpend({ limitMicros: 1_000, maximumMicros: 700 });
  expect(firstReservation).toBeTruthy();
  settleSummarySpend(firstReservation!, 250);

  expect(reserveSummarySpend({ limitMicros: 1_000, maximumMicros: 750 })).toBeTruthy();
});

it('charges the full reservation when actual usage is unavailable', () => {
  isolatedLedgerHome();
  const reservation = reserveSummarySpend({ limitMicros: 900, maximumMicros: 900 });
  expect(reservation).toBeTruthy();
  settleSummarySpend(reservation!);

  expect(reserveSummarySpend({ limitMicros: 900, maximumMicros: 1 })).toBeUndefined();
});

it('keeps abandoned reservations charged across a separate process', async () => {
  isolatedLedgerHome();
  const reservation = reserveSummarySpend({ limitMicros: 900, maximumMicros: 900 });
  expect(reservation).toBeTruthy();
  const childScript = join(process.cwd(), 'tests/fixtures/summary-spend-process.mjs');
  const loader = join(process.cwd(), 'tests/fixtures/summary-spend-ts-loader.mjs');

  const runChild = runFile(process.execPath, ['--experimental-loader', loader, childScript, 'reserve'], {
    env: { ...process.env, LEVERFRAME_HOME: process.env['LEVERFRAME_HOME'] },
  });

  const result = await runChild;
  expect(result.stdout.trim(), 'A second process must see the outstanding charge').toBe('denied');
});

it('allows only one real process to reserve the final available balance', async () => {
  const home = isolatedLedgerHome();
  const childScript = join(process.cwd(), 'tests/fixtures/summary-spend-process.mjs');
  const loader = join(process.cwd(), 'tests/fixtures/summary-spend-ts-loader.mjs');
  const runChild = () => runFile(process.execPath, ['--experimental-loader', loader, childScript, 'compete'], {
    env: { ...process.env, LEVERFRAME_HOME: home },
  });

  const results = await Promise.all([runChild(), runChild()]);

  expect(results.map(result => result.stdout.trim()).sort()).toEqual(['denied', 'reserved']);
});
