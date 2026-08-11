import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function useIsolatedTestHome(prefix: string): void {
  const previousHome = process.env.LEVERFRAME_HOME;
  const testHome = mkdtempSync(join(tmpdir(), `${prefix}-`));
  process.env.LEVERFRAME_HOME = testHome;

  afterAll(() => {
    if (previousHome === undefined) delete process.env.LEVERFRAME_HOME;
    else process.env.LEVERFRAME_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  });
}
