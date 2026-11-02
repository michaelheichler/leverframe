import { createHash } from 'node:crypto';
import type { RegistryAccount } from './registry/types.js';

export function normalizeAccountTag(value: string): string {
  const tag = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(tag) || tag === 'AUTO') throw new Error('Use 3 to 4 letters or digits. AUTO names the automatic pool.');
  return tag;
}

export function validateAccountName(value: string): string {
  const name = value.trim();
  const control = Array.from(value).some(character => character.charCodeAt(0) < 32
    || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159));
  if (!name || name.length > 80 || control) throw new Error('Use an account name of 1 to 80 characters without control characters.');
  return name;
}

export function accountTag(account: RegistryAccount, accounts: readonly RegistryAccount[]): string {
  const used = new Set(accounts.flatMap(item => item.tag ? [normalizeAccountTag(item.tag)] : []));
  const generated = new Map<string, string>();
  for (const item of [...accounts].sort((left, right) => left.id.localeCompare(right.id))) {
    if (item.tag) continue;
    let attempt = 0;
    let tag: string;
    do {
      tag = createHash('sha256').update(`${item.id}:${attempt++}`).digest('hex').slice(0, 4).toUpperCase();
    } while (used.has(tag));
    used.add(tag);
    generated.set(item.id, tag);
  }
  return account.tag ? normalizeAccountTag(account.tag) : generated.get(account.id) ?? accountTag(account, [...accounts, account]);
}

export function accountModelId(modelId: string, accountId: string): string {
  return `${modelId}@${accountId}`;
}

export function withAccountTags(accounts: readonly RegistryAccount[]): RegistryAccount[] {
  return accounts.map(account => ({ ...account, tag: accountTag(account, accounts) }));
}
