import { execFileSync, spawn } from 'node:child_process';
import { existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAppPathOverride, loadPreferences } from './config.js';
import { findBinaryOnPath } from './binary-lookup.js';
import type { ClaudeInstallation } from './claude-installation.js';

const isWindows = process.platform === 'win32';
const CMD_PATH_METACHARACTERS = /[\r\n"&|<>^()%!]/;

const FALLBACK_PATHS = isWindows
  ? [
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'claude.cmd'),
      join(process.env['APPDATA'] ?? homedir(), 'npm', 'claude'),
      join(homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    ]
  : [
      join(homedir(), '.local', 'bin', 'claude'),
      join(homedir(), '.npm', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];

export function findClaudeBinary(): string | null {
  const environmentOverride = process.env['LEVERFRAME_CLAUDE_PATH'];
  if (environmentOverride?.trim()) {
    return existsSync(environmentOverride) ? environmentOverride : null;
  }

  const override = getAppPathOverride('claude');
  if (override) return existsSync(override) ? override : null;

  return findBinaryOnPath('claude', FALLBACK_PATHS);
}

export function buildClaudeVersionProbe(
  claudePath: string,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env['ComSpec'] || 'cmd.exe',
): { file: string; args: string[] } | null {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(claudePath)) {
    return { file: claudePath, args: ['--version'] };
  }
  if (CMD_PATH_METACHARACTERS.test(claudePath)) return null;
  return {
    file: comSpec,
    args: ['/d', '/s', '/c', `"${claudePath}" --version`],
  };
}

export function getInstalledClaudeVersion(claudePathOverride?: string): string {
  try {
    const claudePath = claudePathOverride ?? findClaudeBinary();
    if (!claudePath) return '2.1.183';
    const probe = buildClaudeVersionProbe(claudePath);
    if (!probe) return '2.1.183';
    const result = execFileSync(probe.file, probe.args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    const match = result.match(/(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  return '2.1.183';
}

export interface BuildClaudeArgsOptions {
  /** Append --dangerously-skip-permissions unless the user already passed a permission flag. */
  bypassPermissions?: boolean;
}

const PERMISSION_OVERRIDE_FLAGS = ['--dangerously-skip-permissions', '--permission-mode'];

export function buildClaudeArgs(
  model: string | undefined,
  extraArgs: string[],
  options: BuildClaudeArgsOptions = {},
): string[] {
  const args = model ? ['--model', model, ...extraArgs] : [...extraArgs];
  const userOverrodePermissions = extraArgs.some(arg => PERMISSION_OVERRIDE_FLAGS.includes(arg));
  if (options.bypassPermissions && !userOverrodePermissions) {
    args.push('--dangerously-skip-permissions');
  }
  return args;
}

export interface LaunchClaudeOptions {
  installation: ClaudeInstallation;
  env: NodeJS.ProcessEnv;
  model: string | undefined;
  extraArgs: string[];
}

export function launchClaude(options: LaunchClaudeOptions): Promise<number> {
  const { installation, env, model, extraArgs } = options;
  return new Promise((resolve) => {
    const launchOverride = env['LEVERFRAME_CLAUDE_LAUNCH_PATH']?.trim();
    const claudePath = launchOverride
      && existsSync(launchOverride)
      && (!isWindows || !CMD_PATH_METACHARACTERS.test(launchOverride))
      ? launchOverride
      : installation.canonicalPath;
    const bypassPermissions = loadPreferences().launch?.bypassPermissions === true;
    const args = buildClaudeArgs(model, extraArgs, { bypassPermissions });

    const debugFileIdx = extraArgs.indexOf('--debug-file');
    const debugLogPath = debugFileIdx !== -1 && extraArgs[debugFileIdx + 1] ? extraArgs[debugFileIdx + 1] : undefined;

    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;

    type WriteCallback = (error?: Error | null) => void;
    const muteWrite = (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | WriteCallback,
      callback?: WriteCallback,
    ): boolean => {
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (debugLogPath) {
        try {
          const str = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          appendFileSync(debugLogPath, `[parent] ${str}`);
        } catch {}
      }
      done?.();
      return true;
    };

    process.stdout.write = muteWrite as typeof process.stdout.write;
    process.stderr.write = muteWrite as typeof process.stderr.write;

    const restore = () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    };

    const child = spawn(claudePath, args, {
      stdio: 'inherit',
      env,
      shell: isWindows,
    });

    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };

    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));

    child.on('exit', (code) => {
      restore();
      resolve(code ?? 0);
    });

    child.on('error', () => {
      restore();
      resolve(1);
    });
  });
}
