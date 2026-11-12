import { afterEach, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { getTemplateById } from '../src/provider-templates.js';
import { fetchTemplateModels } from '../src/registry/fetch-template-models.js';
import { saveRegistry } from '../src/registry/io.js';
import { loadRegistryProviders } from '../src/registry/load.js';
import { createLanguageModel } from '../src/language-model-factory.js';
import { getProvidersPath } from '../src/paths.js';
import { getProviderDebugLogPath } from '../src/log-paths.js';
import { OPENCODE_ZEN_BASE_URL, OPENCODE_ZEN_MODELS_URL } from '../src/opencode-zen.js';

const KEY = 'obviously-fake-zen-supplied-key';
const HEADER_KEY = 'obviously-fake-zen-header-key';
const AUTH_ALIASES = ['x-api-key', 'api-key', 'x-goog-api-key'];
const CUSTOM_HEADERS = { Authorization: `Bearer ${HEADER_KEY}`, 'x-api-key': HEADER_KEY,
  'api-key': HEADER_KEY, 'x-goog-api-key': HEADER_KEY };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function template(id = 'opencode-zen') {
  const result = getTemplateById(id);
  if (!result) throw new Error(`missing provider template: ${id}`);
  return result;
}

function safeFixturePath(path: string): string {
  const home = process.env['LEVERFRAME_TEST_HOME'];
  if (!home) throw new Error('isolated test home is missing');
  const part = relative(resolve(home), resolve(path));
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('fixture path escaped test home');
  return path;
}

function configureSuppliedKey() {
  vi.stubEnv('LEVERFRAME_TEST_ZEN_SUPPLIED_KEY', KEY);
  safeFixturePath(getProvidersPath());
  saveRegistry({ schemaVersion: 1, providers: [{
    id: 'opencode-zen', templateId: 'opencode-zen', name: 'OpenCode Zen', enabled: true,
    authType: 'api', authRef: 'env:LEVERFRAME_TEST_ZEN_SUPPLIED_KEY',
    api: { npm: '@ai-sdk/openai-compatible', url: OPENCODE_ZEN_BASE_URL },
    addedAt: '2026-11-04T00:00:00.000Z',
    modelsCache: { fetchedAt: '2026-11-04T00:00:00.000Z', models: [{
      id: 'fake-free-model', name: 'Fake free model', upstreamModelId: 'fake-free-model',
      npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', isFree: true,
      contextWindow: 100000, outputTokenLimit: 1000,
    }] },
  }] });
}

async function configuredZen(diagnostics: string[]) {
  const providers = await loadRegistryProviders(message => diagnostics.push(message));
  const provider = providers.find(item => item.id === 'opencode-zen');
  if (!provider) throw new Error('configured Zen provider was not materialized');
  return provider;
}

function capturedOutput() {
  const messages: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { messages.push(args.join(' ')); });
  vi.spyOn(console, 'warn').mockImplementation((...args) => { messages.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { messages.push(args.join(' ')); });
  return messages;
}

function debugOutput() {
  const path = safeFixturePath(getProviderDebugLogPath());
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function chatFetch() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
    id: 'chatcmpl_fake', created: 1, model: 'fake-free-model', object: 'chat.completion',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

it('uses only the public credential for official Zen discovery despite supplied keys and auth aliases', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
  const result = await fetchTemplateModels({ ...template(), headers: CUSTOM_HEADERS }, KEY, undefined, CUSTOM_HEADERS);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(OPENCODE_ZEN_MODELS_URL, expect.objectContaining({ method: 'GET', redirect: 'manual' }));
  const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect({ authorization: headers.get('authorization'), aliases: AUTH_ALIASES.map(name => headers.get(name)) })
    .toEqual({ authorization: 'Bearer public', aliases: AUTH_ALIASES.map(() => null) });
  expect(JSON.stringify({ result, headers: Object.fromEntries(headers) }) + debugOutput()).not.toContain(KEY);
  expect(JSON.stringify(Object.fromEntries(headers)) + debugOutput()).not.toContain(HEADER_KEY);
});

it('does not follow a redirect from Zen discovery to another credential receiver', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null,
    { status: 302, headers: { Location: 'https://credential-receiver.invalid/models' } }));
  const result = await fetchTemplateModels(template(), KEY);
  expect(result.models).toEqual([]);
  expect(result.error).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(OPENCODE_ZEN_MODELS_URL, expect.objectContaining({ redirect: 'manual' }));
});

it('still sends the configured credential for non-Zen discovery', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
  await fetchTemplateModels(template('openai'), KEY);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({ method: 'GET', redirect: 'manual' }));
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
});

it('tells the user once that an explicitly configured Zen key is not sent and public access is used', async () => {
  configureSuppliedKey();
  const output = capturedOutput();
  const diagnostics: string[] = [];
  await loadRegistryProviders(message => diagnostics.push(message));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatch(/Zen/i);
  expect(diagnostics[0]).toMatch(/public/i);
  expect(diagnostics[0]).toMatch(/(?:configured|supplied).*key.*(?:not sent|not be sent|ignored)/i);
  expect(JSON.stringify({ output, diagnostics }) + debugOutput()).not.toContain(KEY);
});

it('sends exactly the public credential for inference after resolving an explicit Zen env authRef', async () => {
  configureSuppliedKey();
  const output = capturedOutput();
  const diagnostics: string[] = [];
  const provider = await configuredZen(diagnostics);
  const fetchMock = chatFetch();
  const model = await createLanguageModel({ npm: '@ai-sdk/openai-compatible', modelId: 'fake-free-model',
    apiKey: provider.apiKey, providerId: provider.id, baseURL: OPENCODE_ZEN_BASE_URL, headers: CUSTOM_HEADERS });
  const result = await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });
  expect(result.text).toBe('OK');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith(`${OPENCODE_ZEN_BASE_URL}/chat/completions`, expect.objectContaining({ redirect: 'manual' }));
  const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer public');
  expect(AUTH_ALIASES.map(name => headers.get(name))).toEqual(AUTH_ALIASES.map(() => null));
  expect(JSON.stringify({ output, diagnostics, text: result.text, headers: Object.fromEntries(headers) }) + debugOutput()).not.toContain(KEY);
  expect(JSON.stringify({ output, diagnostics, headers: Object.fromEntries(headers) }) + debugOutput()).not.toContain(HEADER_KEY);
});
