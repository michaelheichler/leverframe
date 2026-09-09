import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { ensureLegacyAppHomeMigrated, resetLegacyMigrationForTests } from '../src/paths.js';

const failures = vi.hoisted(() => ({ copy: true, collide: false, merge: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, cpSync: (...args: Parameters<typeof actual.cpSync>) => {
    if (failures.copy || (failures.merge && String(args[1]).includes('.leverframe/config'))) throw new Error('injected copy failure');
    return actual.cpSync(...args);
  }, renameSync: (...args: Parameters<typeof actual.renameSync>) => {
    if (failures.collide) {
      failures.collide = false;
      actual.mkdirSync(String(args[1]), { recursive: true });
      actual.writeFileSync(join(String(args[1]), 'new-setting.json'), 'preserve');
    }
    return actual.renameSync(...args);
  } };
});
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  resetLegacyMigrationForTests();
  failures.collide = false;
  failures.merge = false;
});

it('recovers a partial merge into a concurrently created destination', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-migration-race-'));
  homes.push(home);
  const legacy = join(home, '.clodex');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'config.json'), 'legacy');
  failures.copy = false;
  failures.collide = true;
  failures.merge = true;
  expect(() => ensureLegacyAppHomeMigrated({ HOME: home })).toThrow('injected copy failure');
  resetLegacyMigrationForTests();
  failures.merge = false;
  ensureLegacyAppHomeMigrated({ HOME: home });
  expect(readFileSync(join(home, '.leverframe', 'config.json'), 'utf8')).toBe('legacy');
  expect(readFileSync(join(home, '.leverframe', 'new-setting.json'), 'utf8')).toBe('preserve');
});

it('publishes only a complete migration and retries after a copy failure', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-migration-'));
  homes.push(home);
  const legacy = join(home, '.clodex');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'config.json'), '{"lastModel":"kept"}');
  failures.copy = true;
  expect(() => ensureLegacyAppHomeMigrated({ HOME: home })).toThrow('injected copy failure');
  expect(existsSync(join(home, '.leverframe'))).toBe(false);
  expect(readdirSync(home)).toEqual(['.clodex']);
  failures.copy = false;
  ensureLegacyAppHomeMigrated({ HOME: home });
  expect(readFileSync(join(home, '.leverframe', 'config.json'), 'utf8')).toBe('{"lastModel":"kept"}');
  expect(readFileSync(join(legacy, 'config.json'), 'utf8')).toBe('{"lastModel":"kept"}');
});

it('lets a later process retry after an earlier migration copy failed', () => {
  const home = mkdtempSync(join(tmpdir(), 'leverframe-migration-process-'));
  homes.push(home);
  const legacy = join(home, '.clodex');
  mkdirSync(legacy);
  writeFileSync(join(legacy, 'config.json'), '{"lastModel":"preserved"}');
  const source = readFileSync(new URL('../src/paths.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
  const run = (fail: boolean) => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    if (${fail}) fs.cpSync = () => { throw new Error('injected child copy failure'); };
    syncBuiltinESMExports();
    const { ensureLegacyAppHomeMigrated } = await import(${JSON.stringify(moduleUrl)});
    ensureLegacyAppHomeMigrated({ HOME: ${JSON.stringify(home)} });
  `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home, LEVERFRAME_HOME: home } });
  const failed = run(true);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('injected child copy failure');
  expect(existsSync(join(home, '.leverframe'))).toBe(false);
  const retried = run(false);
  expect(retried.error).toBeUndefined();
  expect(retried.status).toBe(0);
  expect(readFileSync(join(home, '.leverframe', 'config.json'), 'utf8')).toBe('{"lastModel":"preserved"}');
});
