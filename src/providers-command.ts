// src/providers-command.ts: leverframe providers command, dispatch entry point
import * as p from '@clack/prompts';
import { providerAuthHelpText } from './registry/provider-auth.js';
import { reconcilePendingCredentialDeletes } from './registry/credential-lifecycle.js';
import { leverframeIntro } from './ui.js';
import { parseProvidersArgs, providersHelpText } from './providers-command-args.js';
import { runProvidersAuth, runProvidersRefreshModels } from './providers-command-auth.js';
import {
  runProvidersList,
  runProvidersAdd,
  runProvidersRemove,
  runProvidersHub,
} from './providers-command-crud.js';

export { type ProvidersSubcommand, parseProvidersArgs, providersHelpText } from './providers-command-args.js';
export { runProvidersAuth, runProvidersRefreshModels } from './providers-command-auth.js';
export {
  runProvidersList,
  runProvidersAdd,
  runProvidersRemove,
  providerHubChoiceValue,
  runProvidersHub,
} from './providers-command-crud.js';

async function runProvidersCommandInner(args: string[]): Promise<number> {
  const parsed = parseProvidersArgs(args);
  if (parsed.error) {
    p.log.error(parsed.error);
    return 1;
  }
  if (parsed.showHelp && parsed.subcommand !== 'auth') {
    console.log(providersHelpText());
    return 0;
  }

  if (parsed.subcommand === 'list') return runProvidersList();
  if (parsed.subcommand === 'add') return runProvidersAdd();
  if (parsed.subcommand === 'remove' && parsed.removeId) return runProvidersRemove(parsed.removeId);
  if (parsed.subcommand === 'refresh-models') return runProvidersRefreshModels(parsed.removeId);
  if (parsed.subcommand === 'auth') {
    if (parsed.showHelp || !parsed.removeId) {
      console.log(providerAuthHelpText());
      return 0;
    }
    return runProvidersAuth(parsed.removeId, parsed.authMethod);
  }

  leverframeIntro('Your providers');
  return runProvidersHub();
}

export async function runProvidersCommand(args: string[]): Promise<number> {
  try {
    return await runProvidersCommandInner(args);
  } finally {
    await reconcilePendingCredentialDeletes(message => p.log.warn(message));
  }
}
