import { readFile, writeFile } from 'node:fs/promises';

export type ClaudeExecutableFormat = 'native' | 'script';

export function classifyClaudeExecutable(head: Buffer): ClaudeExecutableFormat {
  if (head.length >= 4) {
    const u32le = head.readUInt32LE(0);
    const u32be = head.readUInt32BE(0);
    if (
      u32le === 0x464c457f ||
      u32le === 0xfeedfacf ||
      u32be === 0xfeedfacf ||
      u32le === 0xfeedface ||
      u32be === 0xfeedface ||
      (head[0] === 0x4d && head[1] === 0x5a)
    ) return 'native';
  }
  return 'script';
}

function isModuleNotFound(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ERR_MODULE_NOT_FOUND';
}

/**
 * Native binaries are read through node-lief. A missing dependency is an
 * install problem, not a damaged or unrecognized binary, so it must say so
 * instead of surfacing as an unreadable target further up the patch pipeline.
 */
async function loadNativeBundleSupport(): Promise<typeof import('./claude-bundle-native.js')> {
  try {
    return await import('./claude-bundle-native.js');
  } catch (err) {
    if (isModuleNotFound(err)) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw new Error(
        `native binary support is unavailable because a required dependency is missing (${detail}). `
        + 'Reinstall Leverframe dependencies (`pnpm install` in a checkout, '
        + 'or `npm install -g @michaelheichler/leverframe`) and retry.',
      );
    }
    throw err;
  }
}

export async function readClaudeContent(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (classifyClaudeExecutable(bytes.subarray(0, 4)) === 'script') return bytes.toString('utf8');
  const { extractClaudeJsFromNativeInstallation, resolveNixBinaryWrapper } = await loadNativeBundleSupport();
  const resolved = resolveNixBinaryWrapper(path) ?? path;
  const extracted = extractClaudeJsFromNativeInstallation(resolved);
  if (!extracted.data) {
    throw new Error(`Failed to extract Claude JavaScript module graph: ${extracted.error ?? 'unknown format'}`);
  }
  return extracted.data.toString('utf8');
}

export async function writeClaudeContent(path: string, content: string): Promise<void> {
  const head = (await readFile(path)).subarray(0, 4);
  if (classifyClaudeExecutable(head) === 'script') {
    await writeFile(path, content, 'utf8');
    return;
  }
  const { repackNativeInstallation, resolveNixBinaryWrapper } = await loadNativeBundleSupport();
  const resolved = resolveNixBinaryWrapper(path) ?? path;
  repackNativeInstallation(resolved, Buffer.from(content), path, true);
}
