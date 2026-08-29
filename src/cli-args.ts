// src/cli-args.ts
// CLI argument parsing: flag/option helpers and the main parseArgs entry point.
import type { ParsedArgs } from './types.js';

const STARTER_CLAUDE_FLAGS = new Set(['--dry-run', '--trace', '--endpoint', '--proxy', '--save-mode', '--help', '-h', '--version', '-v']);
const LEVERFRAME_LAUNCH_FLAGS = new Set(['--provider', '--model']);

function parseLeverframeLaunchFlag(
  arg: string,
  rest: string[],
  index: number,
  parsed: ParsedArgs,
): number | 'error' {
  if (arg === '--provider' || arg === '--model') {
    const value = rest[index + 1];
    if (!value || value.startsWith('-')) {
      parsed.error = `Missing value for ${arg}`;
      return 'error';
    }
    if (arg === '--provider') parsed.launchProvider = value;
    else parsed.launchModel = value;
    return index + 1;
  }
  if (arg.startsWith('--provider=')) {
    parsed.launchProvider = arg.slice('--provider='.length);
    return index;
  }
  if (arg.startsWith('--model=')) {
    parsed.launchModel = arg.slice('--model='.length);
    return index;
  }
  return index;
}

function tryConsumeLeverframeLaunchFlag(
  arg: string,
  rest: string[],
  index: number,
  parsed: ParsedArgs,
): { next: number } | { error: true } | null {
  if (!LEVERFRAME_LAUNCH_FLAGS.has(arg) && !arg.startsWith('--provider=') && !arg.startsWith('--model=')) {
    return null;
  }
  const next = parseLeverframeLaunchFlag(arg, rest, index, parsed);
  if (next === 'error') return { error: true };
  return { next };
}

function consumeServerOptionValue(
  arg: string,
  rest: string[],
  index: number,
  flag: string,
  parsed: ParsedArgs,
): { value: string; next: number } | null {
  if (arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(flag.length + 1), next: index };
  }
  if (arg !== flag) return null;
  const value = rest[index + 1];
  if (!value || value.startsWith('--')) {
    parsed.error = `Missing value for ${flag}`;
    return null;
  }
  return { value, next: index + 1 };
}

function applyServerProvidersOption(value: string, parsed: ParsedArgs): void {
  const trimmed = value.trim();
  if (trimmed === 'all') {
    parsed.serverProvidersMode = 'all';
    parsed.serverProviderIds = undefined;
    return;
  }
  if (trimmed === 'favorites') {
    parsed.serverProvidersMode = 'favorites';
    parsed.serverProviderIds = undefined;
    return;
  }

  const ids = trimmed.split(',').map(id => id.trim()).filter(Boolean);
  if (ids.length === 0) {
    parsed.error = 'Missing provider ids for --providers';
    return;
  }
  parsed.serverProvidersMode = 'specific';
  parsed.serverProviderIds = ids;
}

function emptyParsed(command: ParsedArgs['command']): ParsedArgs {
  return {
    command,
    showHelp: false,
    showVersion: false,
    dryRun: false,
    trace: false,
    claudeArgs: [],
  };
}

function consumeBridgeModeFlag(arg: string, parsed: ParsedArgs): boolean {
  if (arg === '--endpoint') {
    parsed.bridgeMode = 'endpoint';
    return true;
  }
  if (arg === '--proxy') {
    parsed.bridgeMode = 'proxy';
    return true;
  }
  return false;
}

/** --save-mode is only meaningful together with an explicit, endpoint/--proxy. */
function validateSaveModeFlag(parsed: ParsedArgs): void {
  if (parsed.saveBridgeMode && !parsed.bridgeMode && !parsed.error) {
    parsed.error = '--save-mode saves a bridge mode as this command\'s default — combine it with --endpoint or --proxy (e.g. `leverframe claude --proxy --save-mode`)';
  }
}

export function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) return { ...emptyParsed('root'), showHelp: true };

  const [first, ...rest] = args;

  if (first === '--help' || first === '-h') {
    return { ...emptyParsed('root'), showHelp: true };
  }
  if (first === '--version' || first === '-v') {
    return { ...emptyParsed('root'), showVersion: true };
  }

  if (first === 'server') {
    const parsed = emptyParsed('server');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (consumeBridgeModeFlag(arg, parsed)) continue;
      else if (arg === '--save-mode') parsed.saveBridgeMode = true;
      else if (arg === '--ws-diagnostics') parsed.serverWsDiagnostics = true;
      else if (arg === '--no-discovery') parsed.serverNoDiscovery = true;
      else if (arg === '--quick' || arg === '--saved') parsed.serverQuick = true;
      else if (arg === '--mask-gateway-ids') parsed.serverMaskGatewayIds = true;
      else if (arg === '--no-mask-gateway-ids') parsed.serverMaskGatewayIds = false;
      else if (arg === '--listen' || arg.startsWith('--listen=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--listen', parsed);
        if (!consumed) return parsed;
        if (consumed.value !== 'local' && consumed.value !== 'network') {
          parsed.error = '--listen must be "local" or "network"';
          return parsed;
        }
        parsed.serverListenMode = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--providers' || arg.startsWith('--providers=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--providers', parsed);
        if (!consumed) return parsed;
        applyServerProvidersOption(consumed.value, parsed);
        if (parsed.error) return parsed;
        i = consumed.next;
      }
      else if (arg === '--password' || arg.startsWith('--password=')) {
        parsed.error =
          '`--password <value>` is no longer accepted on the command line (it leaks through process listings and shell history). ' +
          'Set LEVERFRAME_SERVER_PASSWORD in the environment for a one-run password, or run `leverframe server` interactively to enter one hidden.';
        return parsed;
      }
      else if (arg === '--port' || arg.startsWith('--port=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--port', parsed);
        if (!consumed) return parsed;
        const port = Number(consumed.value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          parsed.error = '--port must be an integer between 1 and 65535';
          return parsed;
        }
        parsed.serverPort = port;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown server option: ${arg}`;
    }
    validateSaveModeFlag(parsed);
    return parsed;
  }

  if (first === 'models' || first === 'favorites') {
    const parsed = emptyParsed('models');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (arg === '--list') parsed.favoritesList = true;
      else if (arg === '--alias' || arg.startsWith('--alias=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--alias', parsed);
        if (!consumed) return parsed;
        parsed.favoritesAlias = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--unalias' || arg.startsWith('--unalias=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--unalias', parsed);
        if (!consumed) return parsed;
        parsed.favoritesUnalias = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--context-ceiling' || arg.startsWith('--context-ceiling=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--context-ceiling', parsed);
        if (!consumed) return parsed;
        parsed.favoritesContextCeiling = consumed.value;
        i = consumed.next;
      }
      else if (arg === '--no-context-ceiling' || arg.startsWith('--no-context-ceiling=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--no-context-ceiling', parsed);
        if (!consumed) return parsed;
        parsed.favoritesNoContextCeiling = consumed.value;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown models option: ${arg}`;
    }
    return parsed;
  }

  if (first === 'providers') {
    const parsed = emptyParsed('providers');
    parsed.claudeArgs = [];
    for (const arg of rest) {
      if (arg === '--trace') parsed.trace = true;
      else if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else parsed.claudeArgs.push(arg);
    }
    return parsed;
  }

  if (first === 'executions') {
    const parsed = emptyParsed('executions');
    parsed.claudeArgs = rest;
    if (rest.includes('--help') || rest.includes('-h')) parsed.showHelp = true;
    if (rest.includes('--version') || rest.includes('-v')) parsed.showVersion = true;
    return parsed;
  }

  if (first === 'keyring') {
    const parsed = emptyParsed('keyring');
    const action = rest[0];
    if (rest.includes('--help') || rest.includes('-h')) { parsed.showHelp = true; return parsed; }
    if (rest.includes('--version') || rest.includes('-v')) { parsed.showVersion = true; return parsed; }
    if (action !== 'repair') {
      parsed.error = action ? `Unknown keyring action: ${action}` : 'Usage: leverframe keyring repair [--account <account>]';
      return parsed;
    }
    for (let i = 1; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--account' || arg.startsWith('--account=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--account', parsed);
        if (!consumed) return parsed;
        parsed.keyringRepairAccount = consumed.value;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown keyring option: ${arg}`;
    }
    return parsed;
  }

  if (first === 'patch') {
    const parsed = emptyParsed('patch');
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (arg === '--help' || arg === '-h') parsed.showHelp = true;
      else if (arg === '--version' || arg === '-v') parsed.showVersion = true;
      else if (arg === '--restore') parsed.patchRestore = true;
      else if (arg === '--trace') parsed.trace = true;
      else if (arg === '--diagnose') parsed.patchDiagnose = true;
      else if (arg === '--json') parsed.patchJson = true;
      else if (arg === '--target' || arg.startsWith('--target=')) {
        const consumed = consumeServerOptionValue(arg, rest, i, '--target', parsed);
        if (!consumed) return parsed;
        parsed.patchTarget = consumed.value;
        i = consumed.next;
      }
      else if (!parsed.error) parsed.error = `Unknown patch option: ${arg}`;
    }
    if (parsed.patchJson && !parsed.patchDiagnose && !parsed.error) {
      parsed.error = '--json only applies to `leverframe patch --diagnose --json`';
    }
    return parsed;
  }

  if (first !== 'claude') {
    return {
      ...emptyParsed('root'),
      error: first.startsWith('-') ? `Unknown root option: ${first}` : `Unknown command: ${first}`,
    };
  }

  const parsed = emptyParsed('claude');
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === '--') {
      parsed.claudeArgs.push(...rest.slice(i + 1));
      break;
    }

    const consumed = tryConsumeLeverframeLaunchFlag(arg, rest, i, parsed);
    if (consumed !== null) {
      if ('error' in consumed) return parsed;
      i = consumed.next;
      continue;
    }

    if (!STARTER_CLAUDE_FLAGS.has(arg)) {
      parsed.claudeArgs.push(arg);
      continue;
    }

    if (arg === '--dry-run') parsed.dryRun = true;
    if (arg === '--trace') parsed.trace = true;
    consumeBridgeModeFlag(arg, parsed);
    if (arg === '--save-mode') parsed.saveBridgeMode = true;
    if (arg === '--help' || arg === '-h') parsed.showHelp = true;
    if (arg === '--version' || arg === '-v') parsed.showVersion = true;
  }

  validateSaveModeFlag(parsed);
  return parsed;
}
