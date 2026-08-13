// src/providers-command-args.ts, arg parsing and help/label text for the providers command
import pc from 'picocolors';
import type { ProviderAuthMethod } from './registry/provider-auth.js';
import { fmtEnabledStar, fmtProvider } from './ui.js';

export type ProvidersSubcommand = 'hub' | 'add' | 'list' | 'remove' | 'refresh-models' | 'auth' | 'help';

export function parseProvidersArgs(args: string[]): {
  subcommand: ProvidersSubcommand;
  showHelp: boolean;
  removeId?: string;
  authMethod?: ProviderAuthMethod;
  error?: string;
} {
  if (args.length === 0) return { subcommand: 'hub', showHelp: false };
  const [first, ...rest] = args;
  if (first === '--help' || first === '-h') return { subcommand: 'help', showHelp: true };
  if (first === 'add') {
    if (rest.length > 0) return { subcommand: 'add', showHelp: false, error: `Unknown add option: ${rest[0]}` };
    return { subcommand: 'add', showHelp: false };
  }
  if (first === 'list') {
    if (rest.length > 0) return { subcommand: 'list', showHelp: false, error: `Unknown list option: ${rest[0]}` };
    return { subcommand: 'list', showHelp: false };
  }
  if (first === 'auth') {
    if (rest.length === 0) return { subcommand: 'auth', showHelp: true };
    let authMethod: ProviderAuthMethod | undefined;
    const positional: string[] = [];
    for (const arg of rest) {
      if (arg === '--native') authMethod = 'native';
      else if (arg.startsWith('-')) {
        return { subcommand: 'auth', showHelp: false, error: `Unknown auth option: ${arg}` };
      } else {
        positional.push(arg);
      }
    }
    if (positional.length !== 1) {
      return { subcommand: 'auth', showHelp: false, error: 'Usage: leverframe providers auth <id>' };
    }
    return { subcommand: 'auth', showHelp: false, removeId: positional[0], authMethod };
  }
  if (first === 'remove') {
    if (rest.length === 0) return { subcommand: 'remove', showHelp: false, error: 'Usage: leverframe providers remove <id>' };
    if (rest.length > 1) return { subcommand: 'remove', showHelp: false, error: `Unknown remove option: ${rest[1]}` };
    return { subcommand: 'remove', showHelp: false, removeId: rest[0] };
  }
  if (first === 'refresh-models') {
    if (rest.length === 0) return { subcommand: 'refresh-models', showHelp: false };
    if (rest.length > 1) return { subcommand: 'refresh-models', showHelp: false, error: `Unknown refresh-models option: ${rest[1]}` };
    return { subcommand: 'refresh-models', showHelp: false, removeId: rest[0] };
  }
  return { subcommand: 'hub', showHelp: false, error: `Unknown providers subcommand: ${first}` };
}

export function providersHelpText(): string {
  return `${pc.bold('leverframe providers')}: manage supported OpenAI-compatible providers

${pc.bold('Usage:')}
  leverframe providers
  leverframe providers add
  leverframe providers list
  leverframe providers remove <id>
  leverframe providers refresh-models [id]
  leverframe providers auth openai

${pc.bold('Subcommands:')}
  (none)      Provider hub wizard
  add         Add a supported provider with an API key
  auth        Sign in with ChatGPT/Codex-plan OAuth (device code)
  list        Show configured providers
  remove      Remove a provider by id
  refresh-models  Update cached model lists`;
}

export function providerLabel(name: string, modelCount: number, enabled: boolean): string {
  return `${fmtEnabledStar(enabled)} ${fmtProvider(name)} ${pc.dim(`(${modelCount} model${modelCount === 1 ? '' : 's'})`)}`;
}
