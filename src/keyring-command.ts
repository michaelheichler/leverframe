// src/keyring-command.ts: `leverframe keyring` subcommand for repairing corrupted credential journals.

import pc from 'picocolors';
import { classifyKeyringError, repairStoredCredential } from './credential-store.js';
import { oauthProviderKeyringAccount } from './env.js';
import { loadRegistry } from './registry/io.js';
import { VERSION } from './constants.js';

export function keyringHelpText(): string {
  return `${pc.bold('leverframe keyring')} v${VERSION}
Inspect and repair the OS keyring entries that hold provider credentials.

${pc.bold('Usage:')}
  leverframe keyring repair
  leverframe keyring repair --account provider:<id>
  leverframe keyring --help

${pc.bold('Behavior:')}
  repair reconciles each account's credential against its transaction journal.
  A stale journal (for example after a keyring helper was killed mid-write) is
  rebuilt from the published credential. Only when the credential itself is
  unreadable are the account's keyring entries cleared so it can be re-added.

${pc.bold('macOS note:')}
  Keychain approval prompts bind to the node binary. After a node upgrade,
  every leverframe Keychain item asks for approval once more. Answer with
  "Always Allow" so subsequent runs stay silent.`;
}

/** OAuth providers store tokens under a second `oauth:` account, so repair must cover both. */
function registryKeyringAccounts(): string[] {
  const accounts = new Set<string>();
  for (const provider of loadRegistry().providers) {
    if (!provider.authRef.startsWith('keyring:')) continue;
    accounts.add(provider.authRef.slice('keyring:'.length));
    if (provider.authType === 'oauth') accounts.add(oauthProviderKeyringAccount(provider.id));
  }
  return [...accounts];
}

/** Repairs continue past per-account failures because one broken journal must not block the rest. */
export async function runKeyringRepairCommand(accountFilter?: string): Promise<number> {
  const accounts = accountFilter ? [accountFilter] : registryKeyringAccounts();
  if (accounts.length === 0) {
    console.log('No keyring-backed provider credentials are registered.');
    return 0;
  }
  let failures = 0;
  for (const account of accounts) {
    const result = await repairStoredCredential(account);
    if (!result.ok) {
      failures += 1;
      console.error(`${pc.red('✗')} ${account}: ${classifyKeyringError(result.error)}`);
      continue;
    }
    if (result.value !== null) console.log(`${pc.green('✓')} ${account}: credential intact, journal verified`);
    else console.log(`${pc.yellow('•')} ${account}: no readable credential remains. Re-add it via \`leverframe providers\` if this provider needs one.`);
  }
  if (process.platform === 'darwin') {
    console.log(pc.dim('If macOS shows Keychain prompts, choose "Always Allow". A node upgrade invalidates prior approvals.'));
  }
  return failures === 0 ? 0 : 1;
}
