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

export async function readClaudeContent(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (classifyClaudeExecutable(bytes.subarray(0, 4)) === 'script') return bytes.toString('utf8');
  const { extractClaudeJsFromNativeInstallation, resolveNixBinaryWrapper } = await import('./claude-bundle-native.js');
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
  const { repackNativeInstallation, resolveNixBinaryWrapper } = await import('./claude-bundle-native.js');
  const resolved = resolveNixBinaryWrapper(path) ?? path;
  repackNativeInstallation(resolved, Buffer.from(content), path, true);
}
