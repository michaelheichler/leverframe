import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const root = mkdtempSync(join(tmpdir(), 'leverframe-package-'));
try {
  const output = execFileSync(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', root],
    { encoding: 'utf8' },
  );
  const records = JSON.parse(output);
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error('npm pack returned an unexpected result');
  }

  const expected = [
    'LICENSE',
    'README.md',
    'dist/claude-wrapper.js',
    'dist/cli.js',
    'docs/background-agents.md',
    'docs/model-picker.png',
    'package.json',
  ].sort();
  const actual = records[0].files.map(file => file.path).sort();
  const chunks = actual.filter(path => /^dist\/chunk-[A-Z0-9]+\.js$/.test(path));
  const fixed = actual.filter(path => !chunks.includes(path));
  if (chunks.length !== 1 || JSON.stringify(fixed) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected package contents:\n${actual.join('\n')}`);
  }
  if (records[0].unpackedSize > 4_000_000) {
    throw new Error(`Package is unexpectedly large: ${records[0].unpackedSize} bytes`);
  }

  for (const executable of ['dist/cli.js', 'dist/claude-wrapper.js']) {
    const firstLine = readFileSync(executable, 'utf8').split('\n', 1)[0];
    if (firstLine !== '#!/usr/bin/env node') {
      throw new Error(`${executable} is missing its Node shebang`);
    }
  }

  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const archive = join(root, records[0].filename);
  execFileSync(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive],
    { cwd: consumer, stdio: 'pipe' },
  );
  const installedCli = join(
    consumer,
    'node_modules',
    '@michaelheichler',
    'leverframe',
    'dist',
    'cli.js',
  );
  const version = execFileSync(process.execPath, [installedCli, '--version'], {
    cwd: consumer,
    encoding: 'utf8',
  }).trim();
  if (version !== packageVersion) throw new Error(`Packed CLI returned unexpected version: ${version}`);
  const smoke = `
    const sdk = await import('@github/copilot-sdk');
    const client = new sdk.CopilotClient({
      connection: sdk.RuntimeConnection.forStdio(),
      mode: 'empty',
      gitHubToken: 'package-smoke-token',
      useLoggedInUser: false,
      baseDirectory: process.cwd(),
      workingDirectory: process.cwd(),
      logLevel: 'none',
      telemetry: { captureContent: false },
      sessionFs: {
        initialCwd: process.cwd(),
        sessionStatePath: '/session',
        conventions: 'posix',
        capabilities: { sqlite: false },
      },
      env: {},
    });
    await client.forceStop();
  `;
  execFileSync(process.execPath, ['--input-type=module', '--eval', smoke], {
    cwd: consumer,
    stdio: 'pipe',
  });

  console.log(`Package contents and Copilot runtime verified: ${actual.length} files, ${records[0].unpackedSize} bytes`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
