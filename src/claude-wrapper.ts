

import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  orderWrapperServerCandidates,
  readLiveServerRuntimeStates,
  type ServerRuntimeState,
} from './server-runtime.js';
import { computeWrapperEnv } from './wrapper-env.js';
import { findClaudeBinary } from './launch.js';

const isWindows = process.platform === 'win32';

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (!isWindows) accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function looksLikeWrapperContractPath(arg: string): boolean {
  if (!arg) return false;
  if (existsSync(arg)) return true;
  if (arg.includes('/') || arg.includes('\\')) return true;
  const base = arg.toLowerCase();
  return base === 'claude' || base.startsWith('claude.');
}

export function execIntoClaude(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): void {
  if (isWindows || typeof process.execve !== 'function') return;
  if (!isExecutableFile(file)) return;
  try {
    process.execve(file, [file, ...args], env);
  } catch {

  }
}

function portIsOpen(port: number, timeoutMs = 100): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let claudePath: string | null;
  let claudeArgs: string[];
  if (argv[0] && isExecutableFile(argv[0])) {

    claudePath = argv[0];
    claudeArgs = argv.slice(1);
  } else {
    claudePath = findClaudeBinary();
    claudeArgs = argv;
  }

  if (!claudePath) {
    process.stderr.write('leverframe-claude: could not find the claude binary (set LEVERFRAME_CLAUDE_PATH)\n');
    process.exit(127);
  }

  let state: ServerRuntimeState | null = null;
  for (const candidate of orderWrapperServerCandidates(readLiveServerRuntimeStates())) {
    if (await portIsOpen(candidate.port)) {
      state = candidate;
      break;
    }
  }
  const env = computeWrapperEnv(process.env, state);

  execIntoClaude(claudePath, claudeArgs, env);

  const child = spawn(claudePath, claudeArgs, {
    stdio: 'inherit',
    env,
    shell: isWindows,
  });

  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));

  child.on('error', err => {
    process.stderr.write(`leverframe-claude: failed to launch ${claudePath}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      const signum = osConstants.signals[signal as keyof typeof osConstants.signals];
      process.exit(signum ? 128 + signum : 1);
    }
    process.exit(code ?? 0);
  });
}

function isClaudeWrapperEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isClaudeWrapperEntryPoint()) {
  void main();
}
