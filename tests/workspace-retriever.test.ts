import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createWorkspaceRetriever, type SourceLocation } from '../src/retrieval/workspace-retriever.js';

function fixture(files: Record<string, string | Buffer>) {
  const home = homedir();
  expect(home).toBe(process.env['HOME']);
  expect(process.env['LEVERFRAME_HOME']).toBe(join(home, 'leverframe'));
  const root = mkdtempSync(join(home, 'retrieval-fixture-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const write = (path: string, contents: string | Buffer) => {
    const target = join(root, path);
    const fromRoot = relative(root, target);
    expect(isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)).toBe(false);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  for (const [path, contents] of Object.entries(files)) write(path, contents);
  git('add', '--all');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture');
  return { root, write, git };
}

function location(path: string, contents: string | Buffer, startLine = 1, endLine = startLine): SourceLocation {
  return { path, startLine, endLine, sha256: createHash('sha256').update(contents).digest('hex') };
}

it('returns exact file locations in path order without exposing source', async () => {
  const contents = 'PRIVATE_FIXTURE_LINE';
  const { root } = fixture({ 'b/example.ts': contents, 'a/example.ts': contents, 'example.ts.bak': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search('example.ts');

  expect(result).toEqual({
    locations: [location('a/example.ts', contents), location('b/example.ts', contents)],
    truncated: false,
  });
});

it('finds whole identifier occurrences and includes usages', async () => {
  const contents = 'const mark = 1;\nconst watermark = 2;\nconsole.log(mark);';
  const { root } = fixture({ 'script.ts': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search('mark');

  expect(result).toEqual({ locations: [location('script.ts', contents), location('script.ts', contents, 3)], truncated: false });
});

it.each([' leading.ts', 'dir/trailing.ts '])('preserves significant whitespace when searching for %j', async path => {
  const contents = 'const marker = 1';
  const { root } = fixture({ [path]: contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search(path);

  expect(result).toEqual({ locations: [location(path, contents)], truncated: false });
});

it('trims incidental whitespace around identifier searches', async () => {
  const contents = 'export const marker = 1';
  const { root } = fixture({ 'source.ts': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search('  marker ');

  expect(result).toEqual({ locations: [location('source.ts', contents)], truncated: false });
});

it('does not let Git read commands invoke a repository fsmonitor hook', async () => {
  const source = 'marker';
  const { root, git, write } = fixture({ 'source.ts': source });
  const hook = join(root, '.git', 'fixture-monitor');
  const called = join(root, '.git', 'monitor-called');
  write('.git/fixture-monitor', '#!/bin/sh\nprintf called > .git/monitor-called\n');
  git('config', 'core.fsmonitor', `sh "${hook}"`);
  git('update-index', '--fsmonitor');
  git('status', '--porcelain');
  expect(existsSync(called)).toBe(true);
  rmSync(called);
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search('source.ts');

  expect(result.locations).toEqual([location('source.ts', source)]);
  expect(existsSync(called)).toBe(false);
});

it('reports when matching locations exceed the response limit', async () => {
  const contents = 'marker\n'.repeat(6);
  const { root } = fixture({ 'script.ts': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search('marker');

  expect(result.locations.map(row => row.startLine)).toEqual([1, 2, 3, 4, 5]);
  expect(result.truncated).toBe(true);
});

it.each([
  ['missingIdentifier', [], true],
  ['z/target.ts', ['z/target.ts'], false],
])('reports the scan limit without hiding exact file matches for %s', async (query, paths, truncated) => {
  const files = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`a/file-${index}.ts`, 'marker']));
  const { root } = fixture({ ...files, 'z/target.ts': 'other' });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.search(query);

  expect(result.truncated).toBe(truncated);
  expect(result.locations.map(row => row.path)).toEqual(paths);
});

it('rejects a previously read location after a dirty edit', async () => {
  const { root, write } = fixture({ 'source.ts': 'oldMarker' });
  const retriever = await createWorkspaceRetriever(root);
  const earlier = location('source.ts', 'oldMarker');
  await expect(retriever.read(earlier)).resolves.toMatchObject({ status: 'ok', text: 'oldMarker' });
  write('source.ts', 'newMarker');

  const result = await retriever.read(earlier);

  expect(result).toEqual({ status: 'stale' });
});

it('rejects a tracked path through a symlink ancestor', async () => {
  const { root } = fixture({ 'src/file.ts': 'marker' });
  renameSync(join(root, 'src'), join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(root, 'src'), 'dir');
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.read(location('src/file.ts', 'marker'));

  expect(result).toEqual({ status: 'unavailable' });
});

it.each([
  ['credentials.json', 'private'],
  ['../package.json', 'outside'],
  ['untracked.txt', 'dirty'],
  ['binary.dat', Buffer.from([0, 1, 2])],
  ['invalid.txt', Buffer.from([0xff])],
])('refuses to return unsafe or untracked source at %s', async (path, content) => {
  const { root, write } = fixture({ 'credentials.json': 'private', 'binary.dat': Buffer.from([0, 1, 2]), 'invalid.txt': Buffer.from([0xff]) });
  write('untracked.txt', 'dirty');
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.read(location(path, content));

  expect(result).toEqual({ status: 'unavailable' });
});

it('clips source without splitting a UTF-8 character', async () => {
  const contents = `a${'🙂'.repeat(600)}`;
  const { root } = fixture({ 'source.ts': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.read(location('source.ts', contents));

  expect(result).toMatchObject({ status: 'ok', text: `a${'🙂'.repeat(511)}`, truncated: true });
});

it('returns at most twenty requested source lines', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`);
  const contents = lines.join('\n');
  const { root } = fixture({ 'source.ts': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.read(location('source.ts', contents, 2, 25));

  expect(result).toMatchObject({ status: 'ok', text: lines.slice(1, 21).join('\n'), truncated: true });
});

it('rejects ranges past the end of the current file', async () => {
  const contents = 'one line';
  const { root } = fixture({ 'source.ts': contents });
  const retriever = await createWorkspaceRetriever(root);

  const result = await retriever.read(location('source.ts', contents, 1, 2));

  expect(result).toEqual({ status: 'invalid-range' });
});

it.each([
  [299_999, true],
  [300_000, false],
])('reuses exact read results only before expiry at %d milliseconds', async (now, sameResult) => {
  let time = 0;
  const { root } = fixture({ 'source.ts': 'marker' });
  const retriever = await createWorkspaceRetriever(root, () => time);
  const request = location('source.ts', 'marker');
  const initial = await retriever.read(request);
  time = now;

  const result = await retriever.read(request);

  expect(result).toEqual({ status: 'ok', location: request, text: 'marker', truncated: false });
  expect(result === initial).toBe(sameResult);
});

it('evicts the least recently used read when a 65th range enters the cache', async () => {
  const contents = Array.from({ length: 65 }, (_, index) => `line ${index + 1}`).join('\n');
  const { root } = fixture({ 'source.ts': contents });
  const retriever = await createWorkspaceRetriever(root);
  const firstRange = location('source.ts', contents);
  const initial = await retriever.read(firstRange);
  for (let line = 2; line <= 65; line++) await retriever.read(location('source.ts', contents, line));

  const result = await retriever.read(firstRange);

  expect(result).toEqual(initial);
  expect(result).not.toBe(initial);
});
