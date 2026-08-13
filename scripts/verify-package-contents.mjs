import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const output = execFileSync(
  npm,
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
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

console.log(`Package contents verified: ${actual.length} files, ${records[0].unpackedSize} bytes`);
