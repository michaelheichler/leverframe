/**
 * Implements the SDK SessionFs contract without touching disk.
 * Each provider owns one session, so prompts, events, and checkpoints vanish at disposal.
 */

import { posix } from 'node:path';

export interface MemorySessionFsFileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtime: string;
  birthtime: string;
}

export interface MemorySessionFsEntry {
  name: string;
  type: 'file' | 'directory';
}

export interface MemorySessionFsProvider {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, mode?: number): Promise<void>;
  appendFile(path: string, content: string, mode?: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<MemorySessionFsFileInfo>;
  mkdir(path: string, recursive: boolean, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithTypes(path: string): Promise<MemorySessionFsEntry[]>;
  rm(path: string, recursive: boolean, force: boolean): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
}

interface MemoryFile {
  content: string;
  birthtime: string;
  mtime: string;
}

type DirectoryMetadata = Omit<MemoryFile, 'content'>;

function filesystemError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function canonicalPath(path: string): string {
  if (!path.startsWith('/')) throw filesystemError('EINVAL', path);
  return posix.normalize(path);
}

function directChild(parent: string, candidate: string): string | undefined {
  if (candidate === parent) return undefined;
  const relative = posix.relative(parent, candidate);
  if (relative.length === 0 || relative.startsWith('../') || relative === '..') return undefined;
  const [child, ...rest] = relative.split('/');
  return rest.length === 0 ? child : undefined;
}

/** Owns one ephemeral filesystem exposed only through the SDK SessionFs interface. */
class MemorySessionFs implements MemorySessionFsProvider {
  private readonly files = new Map<string, MemoryFile>();
  private readonly directories = new Map<string, DirectoryMetadata>();

  constructor() {
    const createdAt = new Date().toISOString();
    this.directories.set('/', { birthtime: createdAt, mtime: createdAt });
  }

  async readFile(path: string): Promise<string> {
    const normalized = canonicalPath(path);
    const file = this.files.get(normalized);
    if (file === undefined) throw filesystemError('ENOENT', normalized);
    return file.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalized = canonicalPath(path);
    this.ensureParent(normalized);
    const now = new Date().toISOString();
    this.files.set(normalized, {
      content,
      birthtime: this.files.get(normalized)?.birthtime ?? now,
      mtime: now,
    });
  }

  async appendFile(path: string, content: string): Promise<void> {
    const normalized = canonicalPath(path);
    await this.writeFile(normalized, `${this.files.get(normalized)?.content ?? ''}${content}`);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = canonicalPath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async stat(path: string): Promise<MemorySessionFsFileInfo> {
    const normalized = canonicalPath(path);
    const file = this.files.get(normalized);
    if (file !== undefined) return this.fileInfo(file);
    const directory = this.directories.get(normalized);
    if (directory === undefined) throw filesystemError('ENOENT', normalized);
    return {
      isFile: false,
      isDirectory: true,
      size: 0,
      mtime: directory.mtime,
      birthtime: directory.birthtime,
    };
  }

  async mkdir(path: string, recursive: boolean): Promise<void> {
    const normalized = canonicalPath(path);
    if (this.directories.has(normalized)) return;
    if (!recursive) {
      this.ensureParent(normalized);
      this.directories.set(normalized, this.newMetadata());
      return;
    }
    let current = '/';
    for (const segment of normalized.split('/').filter(Boolean)) {
      current = posix.join(current, segment);
      if (!this.directories.has(current)) this.directories.set(current, this.newMetadata());
    }
  }

  async readdir(path: string): Promise<string[]> {
    return this.children(path).map(entry => entry.name);
  }

  async readdirWithTypes(path: string): Promise<MemorySessionFsEntry[]> {
    return this.children(path);
  }

  async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    const normalized = canonicalPath(path);
    if (!this.files.has(normalized) && !this.directories.has(normalized)) {
      if (force) return;
      throw filesystemError('ENOENT', normalized);
    }
    if (this.files.delete(normalized)) return;
    if (!recursive && this.children(normalized).length > 0) {
      throw filesystemError('ENOTEMPTY', normalized);
    }
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    for (const file of this.files.keys()) if (file.startsWith(prefix)) this.files.delete(file);
    for (const directory of this.directories.keys()) {
      if (directory === normalized || directory.startsWith(prefix)) this.directories.delete(directory);
    }
  }

  async rename(source: string, destination: string): Promise<void> {
    const from = canonicalPath(source);
    const to = canonicalPath(destination);
    this.ensureParent(to);
    const file = this.files.get(from);
    if (file !== undefined) {
      this.files.delete(from);
      this.files.set(to, file);
      return;
    }
    if (!this.directories.has(from)) throw filesystemError('ENOENT', from);
    this.moveDirectory(from, to);
  }

  private requireDirectory(path: string): string {
    const normalized = canonicalPath(path);
    if (!this.directories.has(normalized)) throw filesystemError('ENOENT', normalized);
    return normalized;
  }

  private ensureParent(path: string): void {
    const parent = posix.dirname(path);
    if (!this.directories.has(parent)) throw filesystemError('ENOENT', parent);
  }

  private children(path: string): MemorySessionFsEntry[] {
    const normalized = this.requireDirectory(path);
    const entries = new Map<string, MemorySessionFsEntry['type']>();
    for (const directory of this.directories.keys()) {
      const name = directChild(normalized, directory);
      if (name !== undefined) entries.set(name, 'directory');
    }
    for (const file of this.files.keys()) {
      const name = directChild(normalized, file);
      if (name !== undefined) entries.set(name, 'file');
    }
    return [...entries]
      .map(([name, type]) => ({ name, type }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  }

  private moveDirectory(from: string, to: string): void {
    const directoryMoves = [...this.directories]
      .filter(([path]) => path === from || path.startsWith(`${from}/`));
    const fileMoves = [...this.files].filter(([path]) => path.startsWith(`${from}/`));
    for (const [path] of directoryMoves) this.directories.delete(path);
    for (const [path] of fileMoves) this.files.delete(path);
    for (const [path, metadata] of directoryMoves) {
      this.directories.set(`${to}${path.slice(from.length)}`, metadata);
    }
    for (const [path, metadata] of fileMoves) {
      this.files.set(`${to}${path.slice(from.length)}`, metadata);
    }
  }

  private fileInfo(file: MemoryFile): MemorySessionFsFileInfo {
    return {
      isFile: true,
      isDirectory: false,
      size: Buffer.byteLength(file.content),
      mtime: file.mtime,
      birthtime: file.birthtime,
    };
  }

  private newMetadata(): DirectoryMetadata {
    const now = new Date().toISOString();
    return { birthtime: now, mtime: now };
  }
}

/** Creates one isolated in-memory filesystem for a single Copilot session. */
export function createMemorySessionFsProvider(): MemorySessionFsProvider {
  return new MemorySessionFs();
}
