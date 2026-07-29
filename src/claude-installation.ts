// src/claude-installation.ts — one Claude Code installation identity, shared by
// startup verification, patching, restore, and launch.
//
// Fixes the design defect recorded in docs/stabilization-and-upstream-plan.md
// section 4.2.1: launch discovery and patch discovery previously used
// different precedence and could silently select two different Claude Code
// binaries on the same machine. `resolveClaudeInstallation` is now the single
// resolver every patch-lifecycle caller must use; `--target` lets a caller
// pin an explicit path (used by `leverframe patch --target <path>`).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { getAppPathOverride } from './config.js';
import { buildClaudeVersionProbe, findClaudeBinary } from './launch.js';

export type InstallationDiscoverySource =
  | 'explicit-target'
  | 'tweakcc-override'
  | 'leverframe-env-override'
  | 'saved-app-override'
  | 'native-local-bin'
  | 'path-lookup'
  | 'platform-fallback';

export type InstallationKind =
  | 'native-local-bin'
  | 'homebrew'
  | 'npm-global'
  | 'npm-local'
  | 'windows-npm'
  | 'custom';

export type ExecutableType = 'binary' | 'windows-shell-launcher' | 'script';

export interface ClaudeInstallation {
  /** The path as discovered, before symlink resolution. */
  logicalPath: string;
  /** realpath(logicalPath) — the exact file that will actually execute. */
  canonicalPath: string;
  /** Alias of canonicalPath; the value patch state is keyed by. */
  installationPath: string;
  discoverySource: InstallationDiscoverySource;
  installationKind: InstallationKind;
  /** SHA-256 hex of canonicalPath — the per-target state directory key. */
  identity: string;
  version: string;
  executableType: ExecutableType;
}

function classifyInstallationKind(canonicalPath: string): InstallationKind {
  const home = homedir();
  const nativeLocalBin = join(home, '.local', 'bin', 'claude');
  if (canonicalPath === nativeLocalBin || canonicalPath.startsWith(`${join(home, '.local', 'bin')}${sep}`)) {
    return 'native-local-bin';
  }
  if (canonicalPath.includes(`${sep}homebrew${sep}`) || canonicalPath.startsWith('/opt/homebrew/') || canonicalPath.startsWith('/usr/local/Cellar/')) {
    return 'homebrew';
  }
  if (canonicalPath.includes(`${sep}npm${sep}`) && canonicalPath.startsWith(home)) {
    return 'npm-local';
  }
  if (/\\npm\\/i.test(canonicalPath) || canonicalPath.includes(`${sep}npm${sep}`)) {
    return process.platform === 'win32' ? 'windows-npm' : 'npm-global';
  }
  return 'custom';
}

function classifyExecutableType(path: string, platform: NodeJS.Platform = process.platform): ExecutableType {
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(path)) return 'windows-shell-launcher';
  return 'binary';
}

function readExactClaudeVersion(path: string): string | null {
  try {
    const probe = buildClaudeVersionProbe(path);
    if (!probe) return null;
    const output = execFileSync(probe.file, probe.args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    return output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function computeIdentity(canonicalPath: string): string {
  return createHash('sha256').update(canonicalPath).digest('hex');
}

/**
 * Locate the candidate logical path plus how it was found, honoring explicit
 * overrides before native and package-manager fallbacks. This is the one
 * discovery order every patch-lifecycle caller (check/patch/restore/diagnose)
 * shares; launch discovery (`findClaudeBinary`) is folded in as the final,
 * lowest-priority fallback so a plain install without any override resolves
 * identically for launch and for patch.
 */
function discoverLogicalPath(
  explicitTarget?: string,
): { path: string; source: InstallationDiscoverySource } | null {
  if (explicitTarget?.trim()) {
    return { path: explicitTarget.trim(), source: 'explicit-target' };
  }

  const tweakccOverride = process.env['TWEAKCC_CC_INSTALLATION_PATH'];
  if (tweakccOverride?.trim()) {
    return { path: tweakccOverride.trim(), source: 'tweakcc-override' };
  }

  const leverframeOverride = process.env['LEVERFRAME_CLAUDE_PATH'];
  if (leverframeOverride?.trim()) {
    // Preserves findClaudeBinary's contract: an explicit override that does
    // not exist yields no result rather than silently falling back.
    return existsSync(leverframeOverride) ? { path: leverframeOverride, source: 'leverframe-env-override' } : null;
  }

  const savedOverride = getAppPathOverride('claude');
  if (savedOverride) {
    return existsSync(savedOverride) ? { path: savedOverride, source: 'saved-app-override' } : null;
  }

  const nativeSymlink = join(homedir(), '.local', 'bin', 'claude');
  if (existsSync(nativeSymlink)) {
    return { path: nativeSymlink, source: 'native-local-bin' };
  }

  const found = findClaudeBinary();
  return found ? { path: found, source: 'path-lookup' } : null;
}

export interface ResolveInstallationOptions {
  /** `leverframe patch --target <path>` — pin an explicit installation path. */
  target?: string;
}

/**
 * Resolve the one Claude Code installation identity used across startup
 * verification, patching, restore, and launch. Returns null if no candidate
 * resolves to a readable, versioned executable.
 */
export function resolveClaudeInstallation(options: ResolveInstallationOptions = {}): ClaudeInstallation | null {
  const discovered = discoverLogicalPath(options.target);
  if (!discovered) return null;
  const { path: logicalPath, source: discoverySource } = discovered;

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(logicalPath);
  } catch {
    return null;
  }

  try {
    const stats = lstatSync(canonicalPath);
    if (stats.isSymbolicLink() || !statSync(canonicalPath).isFile()) return null;
  } catch {
    return null;
  }

  const version = readExactClaudeVersion(canonicalPath);
  if (!version) return null;

  return {
    logicalPath,
    canonicalPath,
    installationPath: canonicalPath,
    discoverySource,
    installationKind: classifyInstallationKind(canonicalPath),
    identity: computeIdentity(canonicalPath),
    version,
    executableType: classifyExecutableType(canonicalPath),
  };
}
