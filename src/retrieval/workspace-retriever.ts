import { createHash } from 'node:crypto';
import { openWorkspace, type WorkspaceFiles } from './workspace-files.js';

const MAX_PATHS = 256;
const MAX_LOCATIONS = 5;
const MAX_SOURCE_LINES = 20;
const MAX_SOURCE_BYTES = 2048;
const CACHE_CAPACITY = 64;
const CACHE_TTL_MS = 5 * 60 * 1000;
const TOOL_VERSION = 1;

export interface SourceLocation {
  path: string;
  startLine: number;
  endLine: number;
  sha256: string;
}

export interface SearchResult {
  locations: SourceLocation[];
  truncated: boolean;
}

type SourceRead = Readonly<{ status: 'ok'; location: Readonly<SourceLocation>; text: string; truncated: boolean }>;
export type ReadResult = SourceRead | { status: 'unavailable' | 'stale' | 'invalid-range' };

export interface WorkspaceRetriever {
  search(query: string): Promise<SearchResult>;
  read(location: SourceLocation): Promise<ReadResult>;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceLines(bytes: Buffer): string[] {
  return bytes.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
}

async function searchWorkspace(workspace: WorkspaceFiles, query: string): Promise<SearchResult> {
  const needle = query.trim();
  if (query === '' || Buffer.byteLength(query) > 256) throw new RangeError('Use a query of 1 to 256 UTF-8 bytes.');

  const paths = await workspace.list();
  const fileMatches = paths.filter(path => path === query || path.split('/').at(-1) === query);
  const fileMatchSet = new Set(fileMatches);
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(needle)
    ? new RegExp(`(?:^|[^A-Za-z0-9_$])${needle.replaceAll('$', '\\$')}(?=$|[^A-Za-z0-9_$])`)
    : null;
  const candidates = identifier ? [...fileMatches, ...paths.filter(path => !fileMatchSet.has(path))] : fileMatches;
  const locations: SourceLocation[] = [];
  for (const path of candidates.slice(0, MAX_PATHS)) {
    const bytes = await workspace.inspectListedFile(path);
    if (!bytes) continue;
    const fileMatch = fileMatchSet.has(path);
    const lines = fileMatch ? [''] : sourceLines(bytes);
    let sha256: string | undefined;
    for (const [index, line] of lines.entries()) {
      if (!fileMatch && !identifier?.test(line)) continue;
      if (locations.length === MAX_LOCATIONS) return { locations, truncated: true };
      sha256 ??= hash(bytes);
      locations.push({ path, startLine: index + 1, endLine: index + 1, sha256 });
    }
  }
  return { locations, truncated: candidates.length > MAX_PATHS };
}

export async function createWorkspaceRetriever(root: string, now = Date.now): Promise<WorkspaceRetriever> {
  const workspace = await openWorkspace(root);
  const recentReads = new Map<string, { read: SourceRead; expiresAt: number }>();

  return {
    search: query => searchWorkspace(workspace, query),
    async read(location) {
      const { path, startLine, endLine, sha256 } = location;
      if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
        return { status: 'invalid-range' };
      }
      const bytes = await workspace.read(path);
      if (!bytes) return { status: 'unavailable' };
      if (hash(bytes) !== sha256) return { status: 'stale' };

      const key = JSON.stringify([workspace.root, TOOL_VERSION, path, startLine, endLine, sha256]);
      const cached = recentReads.get(key);
      const time = now();
      if (cached) {
        recentReads.delete(key);
        if (cached.expiresAt > time) {
          recentReads.set(key, cached);
          return cached.read;
        }
      }

      const lines = sourceLines(bytes);
      if (endLine > lines.length) return { status: 'invalid-range' };
      const lastLine = Math.min(endLine, startLine + MAX_SOURCE_LINES - 1);
      const source = Buffer.from(lines.slice(startLine - 1, lastLine).join('\n'));
      const truncated = lastLine < endLine || source.length > MAX_SOURCE_BYTES;
      const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(source.subarray(0, MAX_SOURCE_BYTES), { stream: true });
      const read = Object.freeze({ status: 'ok' as const, location: Object.freeze({ path, startLine, endLine, sha256 }), text, truncated });

      if (recentReads.size === CACHE_CAPACITY) recentReads.delete(recentReads.keys().next().value!);
      recentReads.set(key, { read, expiresAt: time + CACHE_TTL_MS });
      return read;
    },
  };
}
