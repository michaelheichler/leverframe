import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reserveAccount, type ReserveResult } from '../../src/account-pool.js';

async function waitForStart(path: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('Process barrier timed out');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

function selectedAccount(result: ReserveResult): string {
  if (result.kind !== 'reserved') throw new Error('No account was reserved');
  return result.reservation.accountId;
}

async function main(): Promise<void> {
  const workerId = process.env.LEVERFRAME_ACCOUNT_POOL_WORKER_ID!;
  const syncDir = process.env.LEVERFRAME_ACCOUNT_POOL_SYNC_DIR!;
  const statePath = process.env.LEVERFRAME_ACCOUNT_POOL_STATE_PATH!;
  writeFileSync(join(syncDir, `${workerId}.ready`), 'ready');
  await waitForStart(join(syncDir, 'start'));

  const result = await reserveAccount({
    pool: { providerId: 'anthropic-api', modelId: 'process-fixture', billingType: 'api' },
    accounts: [{ id: 'process-alpha', enabled: true }, { id: 'process-beta', enabled: true }],
    balancing: true,
    sessionId: `process-session-${workerId}`,
    now: 500,
    statePath,
  });
  writeFileSync(join(syncDir, `${workerId}.result`), selectedAccount(result));
}

main().catch(error => {
  process.stderr.write(`Account-pool fixture failed (${error instanceof Error ? error.name : 'unknown error'}).\n`);
  process.exitCode = 1;
});
