import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { expect, it } from 'vitest';
import {
  CLAUDE_MODULE_BOUNDARY,
  extractClaudeJsFromNativeInstallation,
  repackNativeInstallation,
  splitModulePayload,
} from '../src/claude-bundle-native.js';

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

function writeWithin(directory: string, path: string, content: string): void {
  expect(inside(directory, dirname(path))).toBe(true);
  writeFileSync(path, content, 'utf8');
}

interface Fixture {
  directory: string;
  binary: string;
  repacked: string;
  entry: string;
  bunfig: string;
  env: NodeJS.ProcessEnv;
  testHome: string;
}

function createFixture(): Fixture {
  const home = process.env['HOME'];
  const userProfile = process.env['USERPROFILE'];
  const testHome = process.env['LEVERFRAME_TEST_HOME'];
  const leverframeHome = process.env['LEVERFRAME_HOME'];
  expect(home).toBeTruthy();
  expect(userProfile).toBeTruthy();
  expect(testHome).toBeTruthy();
  expect(leverframeHome).toBeTruthy();
  expect(inside(home!, testHome!)).toBe(true);
  expect(inside(userProfile!, leverframeHome!)).toBe(true);
  expect(inside(home!, leverframeHome!)).toBe(true);
  expect(inside(home!, testHome!)).toBe(true);
  mkdirSync(testHome!, { recursive: true });

  const fixtureDirectory = mkdtempSync(join(testHome!, 'native-module-link-'));
  expect(inside(testHome!, fixtureDirectory)).toBe(true);
  const childHome = join(fixtureDirectory, 'home');
  mkdirSync(childHome);
  const entryPath = join(fixtureDirectory, 'cli.ts');
  const helperPath = join(fixtureDirectory, 'helper.ts');
  const bunfigPath = join(fixtureDirectory, 'bunfig.toml');
  const binaryPath = join(fixtureDirectory, 'cli');
  const repackedPath = join(fixtureDirectory, 'repacked-cli');
  writeWithin(fixtureDirectory, entryPath, [
    'async function run() {',
    "  const loaded = await import('./helper.ts');",
    '  console.log(JSON.stringify({ answer: loaded.answer() }));',
    '}',
    'void run();',
  ].join('\n'));
  writeWithin(fixtureDirectory, helperPath, [
    "import { AsyncLocalStorage } from 'node:async_hooks';",
    "const scope = new AsyncLocalStorage<string>();",
    "export function answer() { return scope.run('linked-fixture-ok', () => scope.getStore()); }",
  ].join('\n'));
  writeWithin(fixtureDirectory, bunfigPath, '');

  return {
    directory: fixtureDirectory,
    binary: binaryPath,
    repacked: repackedPath,
    entry: entryPath,
    bunfig: bunfigPath,
    testHome: testHome!,
    env: {
      PATH: process.env['PATH'] ?? '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: childHome,
      USERPROFILE: childHome,
      LEVERFRAME_HOME: join(childHome, 'leverframe'),
      LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE: '1',
      LEVERFRAME_LIVE_CLAUDE_COMPACTION_TEST: '0',
      TMPDIR: fixtureDirectory,
    },
  };
}

function buildFixture(fixture: Fixture): void {
  expect(inside(fixture.directory, fixture.binary)).toBe(true);
  const installedBun = execFileSync('which', ['bun'], { env: fixture.env, encoding: 'utf8' }).trim();
  execFileSync(installedBun, ['--no-env-file', `--config=${fixture.bunfig}`, 'build', '--compile',
    `--compile-executable-path=${installedBun}`, '--splitting', '--bytecode', '--format=esm',
    '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig',
    '--no-compile-autoload-package-json', '--chunk-naming=chunk-[hash].js', '--outfile', fixture.binary, fixture.entry], {
    cwd: process.cwd(), env: fixture.env, stdio: 'pipe', timeout: 45_000,
  });
}

function addCrossChunkExport(payload: Buffer): Buffer {
  const parts = splitModulePayload(payload.toString('utf8'));
  expect(parts).not.toBeNull();
  const entryIndex = parts!.findIndex(([, source]) => source.includes('loaded.answer()'));
  const helperIndex = parts!.findIndex(([, source]) => source.includes('function answer()'));
  expect(entryIndex).toBeGreaterThanOrEqual(0);
  expect(helperIndex).toBeGreaterThanOrEqual(0);
  const helperName = parts![helperIndex]![0];
  const helperSpecifier = JSON.stringify(helperName);
  parts![entryIndex]![1] = `import{ai as __lfNoticeAi,__lfRecoveryRun}from${helperSpecifier};\n`
    + parts![entryIndex]![1].replace('loaded.answer()',
      'loaded.answer() + "|" + loaded.extra() + "|" + __lfNoticeAi().get(process.stdout) + "|" + '
        + `await (async()=>{let s=await import(${helperSpecifier});return __lfRecoveryRun({kind:"bound"},async()=>{await Promise.resolve();return s.__lfRecoveryCurrent()?.kind})})()`);
  parts![helperIndex]![1] += '\nexport function extra() { return "linked-fixture-extra"; }'
    + 'export function ai(){return{get(){return"linked-notice-host"}}}'
    + 'export function __lfRecoveryRun(value,action){return scope.run(value,action)}'
    + 'export function __lfRecoveryCurrent(){return scope.getStore()}\n';
  return Buffer.from(parts!.map(([name, source]) => `${CLAUDE_MODULE_BOUNDARY}${name}\n${source}`).join(''));
}

function repackFixture(fixture: Fixture): void {
  const extracted = extractClaudeJsFromNativeInstallation(fixture.binary, undefined, { allowNetwork: false });
  expect(extracted.data).toBeInstanceOf(Buffer);
  const completePayload = addCrossChunkExport(extracted.data!);
  expect(inside(fixture.directory, fixture.repacked)).toBe(true);
  repackNativeInstallation(fixture.binary, completePayload, fixture.repacked, true);
}

function runFixture(fixture: Fixture): string {
  return execFileSync(fixture.repacked, [], {
    cwd: fixture.directory, env: fixture.env, encoding: 'utf8', timeout: 15_000,
  });
}

it('links the notice host import and dynamic recovery scope after repacking the complete Bun module map', () => {
  const fixture = createFixture();
  try {
    buildFixture(fixture);
    repackFixture(fixture);
    expect(runFixture(fixture).trim()).toBe('{"answer":"linked-fixture-ok|linked-fixture-extra|linked-notice-host|bound"}');
  } finally {
    expect(inside(fixture.testHome, fixture.directory)).toBe(true);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
