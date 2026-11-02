import { describe, expect, it } from 'vitest';
import type { RegistryAccount } from '../src/registry/types.js';
import {
  accountModelId,
  accountTag,
  normalizeAccountTag,
  validateAccountName,
} from '../src/account-identity.js';

function account(id: string, partial: Partial<RegistryAccount> = {}): RegistryAccount {
  return { id, authRef: `keyring:provider:fixture:${id}`, enabled: true, ...partial };
}

describe('account identity labels', () => {
  it('generates stable distinct short tags for unnamed accounts', () => {
    const accounts = [account('workspace-one'), account('workspace-two')];
    const first = accountTag(accounts[0]!, accounts);
    const second = accountTag(accounts[1]!, accounts);

    expect(accountTag(accounts[0]!, accounts)).toBe(first);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Z0-9]{3,4}$/);
    expect(second).toMatch(/^[A-Z0-9]{3,4}$/);
  });

  it('normalizes chosen tags and rejects invalid or reserved tags', () => {
    expect(normalizeAccountTag('  dev ')).toBe('DEV');
    expect(() => normalizeAccountTag('ab')).toThrow();
    expect(() => normalizeAccountTag('five5')).toThrow();
    expect(() => normalizeAccountTag('A-B')).toThrow();
    expect(() => normalizeAccountTag('AUTO')).toThrow();
  });

  it('validates and trims account names without control characters', () => {
    expect(validateAccountName('  Personal key  ')).toBe('Personal key');
    expect(() => validateAccountName('')).toThrow();
    expect(() => validateAccountName('   ')).toThrow();
    expect(() => validateAccountName(`unsafe\nname`)).toThrow();
    expect(() => validateAccountName('x'.repeat(81))).toThrow();
  });

  it('gives the same model separate route identities for separate accounts', () => {
    expect(accountModelId('claude-sonnet', 'work')).toBe('claude-sonnet@work');
    expect(accountModelId('claude-sonnet', 'personal')).toBe('claude-sonnet@personal');
  });

});
