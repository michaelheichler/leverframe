import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJsonSync } from './atomic-file.js';
import { getAppHome } from './paths.js';
import { assertRegistryWriteOwnership, withRegistryWriteLock } from './registry/lock.js';
import type { PoolKey } from './account-pool.js';

interface Activity {
  pool: PoolKey;
  activeAccountId: string;
  switchReason: string;
  selectedAt: number;
}

function activityPath(): string {
  return join(getAppHome(), 'account-pool-activity.json');
}

function readActivities(): Activity[] {
  try {
    const value: unknown = JSON.parse(readFileSync(activityPath(), 'utf8'));
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object'
      && typeof item.pool?.providerId === 'string' && typeof item.activeAccountId === 'string'
      && typeof item.switchReason === 'string' && typeof item.selectedAt === 'number') : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function readLatestPoolActivity(providerId: string): { activeAccountId: string; switchReason: string } | undefined {
  const latest = readActivities().filter(item => item.pool.providerId === providerId)
    .sort((a, b) => b.selectedAt - a.selectedAt)[0];
  return latest && { activeAccountId: latest.activeAccountId, switchReason: latest.switchReason };
}

export async function recordPoolActivity(pool: PoolKey, activeAccountId: string, switched: boolean): Promise<void> {
  const path = activityPath();
  await withRegistryWriteLock(() => {
    const entries = readActivities().filter(item => item.pool.providerId !== pool.providerId
      || item.pool.modelId !== pool.modelId || item.pool.billingType !== pool.billingType);
    entries.push({ pool, activeAccountId, switchReason: switched ? 'quota failover' : 'account selected', selectedAt: Date.now() });
    entries.sort((a, b) => b.selectedAt - a.selectedAt);
    assertRegistryWriteOwnership(path);
    atomicWriteJsonSync(path, entries.slice(0, 256));
  }, { lockPath: `${path}.lock` });
}
