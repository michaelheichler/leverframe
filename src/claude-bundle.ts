import { readFile, writeFile } from 'node:fs/promises';

export type ClaudeExecutableFormat = 'native' | 'script';

interface NativeBundlePaths {
  launcherPath: string;
  payloadPath: string;
}

export interface ClaudeContentReadOptions {
  allowNetwork?: boolean;
}

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

export async function readClaudeContent(
  launcherPath: string,
  version?: string,
  options: ClaudeContentReadOptions = {},
): Promise<string> {
  const bytes = await readFile(launcherPath);
  if (classifyClaudeExecutable(bytes.subarray(0, 4)) === 'script') return bytes.toString('utf8');
  const { extractClaudeJsFromNativeInstallation, resolveNixBinaryWrapper } = await loadNativeBundleSupport();
  const paths: NativeBundlePaths = {
    launcherPath,
    payloadPath: resolveNixBinaryWrapper(launcherPath) ?? launcherPath,
  };
  const extracted = options.allowNetwork === undefined
    ? extractClaudeJsFromNativeInstallation(paths.payloadPath, version)
    : extractClaudeJsFromNativeInstallation(paths.payloadPath, version, options);
  if (!extracted.data) {
    throw new Error(`Failed to extract Claude JavaScript module graph: ${extracted.error ?? 'unknown format'}`);
  }
  return extracted.data.toString('utf8');
}

export async function writeClaudeContent(launcherPath: string, content: string): Promise<void> {
  const head = (await readFile(launcherPath)).subarray(0, 4);
  if (classifyClaudeExecutable(head) === 'script') {
    await writeFile(launcherPath, content, 'utf8');
    return;
  }
  const { repackNativeInstallation, resolveNixBinaryWrapper } = await loadNativeBundleSupport();
  const paths: NativeBundlePaths = {
    launcherPath,
    payloadPath: resolveNixBinaryWrapper(launcherPath) ?? launcherPath,
  };
  if (paths.payloadPath !== paths.launcherPath) {
    throw new Error(
      `Refusing to replace Nix wrapper launcher ${paths.launcherPath} with native payload ${paths.payloadPath}.`,
    );
  }
  repackNativeInstallation(paths.payloadPath, Buffer.from(content), paths.launcherPath, true);
}
