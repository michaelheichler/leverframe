import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

type TestEnvironment = Record<string, string | undefined>;

function canonicalTestDirectory(path: string | undefined): string | null {
  try {
    return path && statSync(path).isDirectory() ? realpathSync.native(path) : null;
  } catch {
    return null;
  }
}

function ownedDirectory(path: string | undefined): string | null {
  try {
    if (!path) return null;
    const directory = lstatSync(path);
    if (!directory.isDirectory()) return null;
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && directory.uid !== currentUid) return null;
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function containedPath(path: string, parent: string, allowEqual: boolean): boolean {
  const remainder = relative(parent, path);
  return remainder === '' ? allowEqual : remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

function ownedTemporaryDirectory(path: string | undefined, tempPath: string | undefined): string | null {
  const realPath = ownedDirectory(path);
  const realTemp = canonicalTestDirectory(tempPath ?? tmpdir());
  return realPath && realTemp && realPath !== realTemp && containedPath(realPath, realTemp, false)
    ? realPath
    : null;
}

function ownedTemporaryBase(path: string, tempPath: string | undefined): string | null {
  const realPath = ownedDirectory(path);
  const realTemp = canonicalTestDirectory(tempPath ?? tmpdir());
  return realPath && realTemp && containedPath(realPath, realTemp, true) ? realPath : null;
}

function defaultTestTempBase(env: TestEnvironment): string {
  const activeBase = env['TMPDIR'] || env['TMP'] || env['TEMP'] || tmpdir();
  if (process.platform !== 'darwin') return activeBase;
  const shortRoot = canonicalTestDirectory('/tmp');
  const canonicalActiveBase = canonicalTestDirectory(activeBase);
  return shortRoot && canonicalActiveBase && containedPath(canonicalActiveBase, shortRoot, true)
    ? activeBase
    : '/tmp';
}

export function safeCandidateTestEnvironment(env: TestEnvironment): {
  candidateHome: string;
  appHome: string;
  configRoot: string;
} | null {
  if (env['LEVERFRAME_CANDIDATE_MODE'] !== '1' || !env['CANDIDATE_HOME'] || env['HOME'] !== env['CANDIDATE_HOME']) return null;
  const candidateHome = ownedTemporaryDirectory(env['CANDIDATE_HOME'], env['TMPDIR'] ?? env['TMP'] ?? env['TEMP']);
  const appHome = ownedDirectory(env['LEVERFRAME_HOME']);
  const configRoot = ownedDirectory(env['CANDIDATE_CONFIG']);
  if (!candidateHome || !appHome || !configRoot
    || !containedPath(appHome, candidateHome, false)
    || !containedPath(configRoot, candidateHome, false)) return null;
  return { candidateHome, appHome, configRoot };
}

function safeMarkedWorkerHome(env: TestEnvironment): string | null {
  const home = ownedTemporaryDirectory(env['HOME'], env['TMPDIR'] ?? env['TMP'] ?? env['TEMP']);
  const appHome = ownedDirectory(env['LEVERFRAME_HOME']);
  const testHome = ownedDirectory(env['LEVERFRAME_TEST_HOME']);
  return home && appHome === home && testHome === home ? home : null;
}

export function installTestHomeIsolation(input: {
  env: TestEnvironment;
  registerAfterAll: (cleanup: () => void) => void;
  tempBase?: string;
}): string {
  const { env, registerAfterAll } = input;
  const candidate = safeCandidateTestEnvironment(env);
  if (candidate) return candidate.candidateHome;
  const workerHome = safeMarkedWorkerHome(env);
  if (workerHome) return workerHome;
  const previousTemp = {
    TMPDIR: env['TMPDIR'],
    TMP: env['TMP'],
    TEMP: env['TEMP'],
  };
  const stableTempBase = input.tempBase
    ? ownedTemporaryBase(input.tempBase, env['TMPDIR'] ?? env['TMP'] ?? env['TEMP'])
    : defaultTestTempBase(env);
  if (!stableTempBase) throw new Error('Test temp base must be an owned directory inside the active temporary root.');
  const testHome = mkdtempSync(join(stableTempBase, 'leverframe-vitest-'));
  const privateTemp = join(testHome, 'tmp');
  mkdirSync(privateTemp, { recursive: true, mode: 0o700 });
  const leverframeHome = join(testHome, 'leverframe');
  env['HOME'] = testHome;
  env['USERPROFILE'] = testHome;
  env['LEVERFRAME_HOME'] = leverframeHome;
  env['LEVERFRAME_TEST_HOME'] = leverframeHome;
  env['TMPDIR'] = privateTemp;
  env['TMP'] = privateTemp;
  env['TEMP'] = privateTemp;

  registerAfterAll(() => {
    for (const key of Object.keys(previousTemp) as Array<keyof typeof previousTemp>) {
      const value = previousTemp[key];
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  return testHome;
}
