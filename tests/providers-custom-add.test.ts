import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runProvidersAdd } from '../src/providers-command-crud.js';
import { emptyRegistry, loadRegistry, saveRegistry } from '../src/registry/io.js';

const prompts = vi.hoisted(() => ({
  select: vi.fn(), text: vi.fn(), password: vi.fn(), confirm: vi.fn(),
  error: vi.fn(), info: vi.fn(), success: vi.fn(), stop: vi.fn(), save: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  ...prompts, isCancel: (value: unknown) => typeof value === 'symbol', cancel: vi.fn(),
  log: { error: prompts.error, info: prompts.info, success: prompts.success },
  spinner: () => ({ start: vi.fn(), stop: prompts.stop }),
}));
vi.mock('../src/env.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/env.js')>(),
  saveProviderCredential: prompts.save,
  deleteProviderCredential: vi.fn().mockResolvedValue(true),
}));
let home: string;
beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), 'leverframe-custom-cli-'));
  vi.stubEnv('LEVERFRAME_HOME', home);
  vi.stubEnv('LEVERFRAME_TRACE', '0');
  saveRegistry(emptyRegistry());
  prompts.select.mockReset().mockResolvedValueOnce('custom:openai').mockResolvedValueOnce('api');
  prompts.text.mockReset().mockResolvedValue('Fixture endpoint');
  prompts.password.mockReset().mockResolvedValueOnce('https://8.8.8.8/v1').mockResolvedValueOnce('fixture-secret');
  prompts.confirm.mockReset().mockResolvedValue(true);
  prompts.save.mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: [{ id: 'fixture-model' }] })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

it('offers custom setup and publishes discovered models with isolated credential storage', async () => {
  expect(await runProvidersAdd()).toBe(0);
  expect(prompts.select.mock.calls[0][0].options).toContainEqual(expect.objectContaining({ value: 'custom:openai' }));
  expect(loadRegistry().providers[0]).toMatchObject({ name: 'Fixture endpoint', authType: 'api' });
  expect(prompts.save).toHaveBeenCalledWith(expect.any(String), 'fixture-secret');
  expect(prompts.text).toHaveBeenCalledTimes(1);
  expect(prompts.password).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(loadRegistry())).not.toContain('fixture-secret');
});

it('requires approval before discovering an anonymous local HTTP endpoint', async () => {
  prompts.select.mockReset().mockResolvedValueOnce('custom:openai').mockResolvedValueOnce('none');
  prompts.password.mockReset().mockResolvedValueOnce('http://127.0.0.1:12345/v1');
  expect(await runProvidersAdd()).toBe(0);
  expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/v1/models', expect.any(Object));
  expect(loadRegistry().providers[0]?.authType).toBe('none');
  expect(prompts.save).not.toHaveBeenCalled();
});

it('does not discover or publish when local approval is declined', async () => {
  prompts.password.mockReset().mockResolvedValueOnce('http://127.0.0.1:12345/v1');
  prompts.confirm.mockResolvedValue(false);
  expect(await runProvidersAdd()).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(loadRegistry().providers).toEqual([]);
});

it.each(['http://8.8.8.8/v1', 'http://169.254.169.254/v1', 'https://user:secret@8.8.8.8/v1'])('rejects unsafe URL %s without auth or discovery', async url => {
  prompts.password.mockReset().mockResolvedValueOnce(url);
  expect(await runProvidersAdd()).toBe(1);
  expect(prompts.password).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(loadRegistry().providers).toEqual([]);
});

it('cancels at the secret prompt without writing credentials or contacting an endpoint', async () => {
  prompts.password.mockReset().mockResolvedValueOnce('https://8.8.8.8/v1').mockResolvedValueOnce(Symbol('cancel'));
  expect(await runProvidersAdd()).toBe(0);
  expect(prompts.save).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('returns failure without publication when model discovery fails', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('unavailable fixture-secret', { status: 503 }));
  expect(await runProvidersAdd()).toBe(1);
  expect(loadRegistry().providers).toEqual([]);
  expect(prompts.save).not.toHaveBeenCalled();
  expect(prompts.stop).toHaveBeenCalled();
  expect(prompts.error).toHaveBeenCalledWith('Provider returned HTTP 503.');
  expect(prompts.info).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  expect(JSON.stringify([prompts.error.mock.calls, prompts.info.mock.calls])).not.toContain('fixture-secret');
});
