import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import {
  createServer, request as httpRequest, type IncomingMessage, type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { LocalProvider } from '../types.js';
import type { CachedModel, ProviderRegistry, RegistryProvider } from '../registry/types.js';
import { materializeRegistry } from '../registry/materialize.js';

export const CANDIDATE_TRANSPORT_NAME = 'loopback-anonymous-v1';
export const CANDIDATE_TEST_CREDENTIAL = 'candidate-loopback-test-credential-v1';
export const CANDIDATE_LISTENER_PORT = 43720;
export const UPSTREAM_MOCK_PORT = 43721;
export const CANDIDATE_HOST = '127.0.0.1';
export const CANDIDATE_MARKER = 'PROVIDER-NEUTRAL-CAPTURE-V1';

export interface CandidateRouteRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly upstreamModelId: string;
  readonly upstreamId: string;
  readonly aliases: readonly string[];
  readonly context: number | null;
  readonly contextWindow: number | null;
  readonly path: string;
  readonly npm: '@ai-sdk/anthropic' | '@ai-sdk/openai-compatible' | '@ai-sdk/openai';
  readonly modelFormat: 'anthropic' | 'openai';
  readonly expectedTransport: {
    readonly npm: CandidateRouteRow['npm'];
    readonly modelFormat: CandidateRouteRow['modelFormat'];
    readonly protocol: 'http-loopback';
    readonly transport?: typeof CANDIDATE_TRANSPORT_NAME;
    readonly endpoint: 'chat.completions' | 'responses' | 'messages';
    readonly requestPathSuffix: '/chat/completions' | '/responses' | '/v1/messages';
    readonly useResponsesLite: boolean;
    readonly preferWebSockets: boolean;
  };
}

const CANDIDATE_ROUTE_DEFINITIONS: readonly Omit<CandidateRouteRow, 'upstreamId' | 'contextWindow'>[] = [
  { providerId: 'kimi', modelId: 'k3', upstreamModelId: 'k3', aliases: ['kimi3'], context: 1_048_576, path: '/kimi/k3', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'openai-oauth', modelId: 'gpt-5.6-luna', upstreamModelId: 'gpt-5.6-luna', aliases: ['luna'], context: null, path: '/openai-oauth/gpt-5.6-luna', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'responses', requestPathSuffix: '/responses', useResponsesLite: true, preferWebSockets: true } },
  { providerId: 'openai-oauth', modelId: 'gpt-5.6-sol', upstreamModelId: 'gpt-5.6-sol', aliases: ['sol'], context: null, path: '/openai-oauth/gpt-5.6-sol', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'responses', requestPathSuffix: '/responses', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'openai-oauth', modelId: 'gpt-5.6-terra', upstreamModelId: 'gpt-5.6-terra', aliases: ['terra'], context: null, path: '/openai-oauth/gpt-5.6-terra', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'responses', requestPathSuffix: '/responses', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'deepseek-v4-flash', upstreamModelId: 'deepseek-v4-flash', aliases: ['deepseek-v4-flash'], context: null, path: '/opencode-go/deepseek-v4-flash', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'deepseek-v4-pro', upstreamModelId: 'deepseek-v4-pro', aliases: ['deepseek-v4-pro'], context: null, path: '/opencode-go/deepseek-v4-pro', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'grok-4.5', upstreamModelId: 'grok-4.5', aliases: ['grok-4.5'], context: null, path: '/opencode-go/grok-4.5', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'hy3', upstreamModelId: 'hy3', aliases: ['hy3'], context: null, path: '/opencode-go/hy3', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'mimo-v2.5-pro', upstreamModelId: 'mimo-v2.5-pro', aliases: ['mimo-v2.5-pro'], context: null, path: '/opencode-go/mimo-v2.5-pro', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'minimax-m3', upstreamModelId: 'minimax-m3', aliases: ['minimax-m3'], context: null, path: '/opencode-go/minimax-m3', npm: '@ai-sdk/anthropic', modelFormat: 'anthropic', expectedTransport: { npm: '@ai-sdk/anthropic', modelFormat: 'anthropic', protocol: 'http-loopback', endpoint: 'messages', requestPathSuffix: '/v1/messages', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'glm-5.2', upstreamModelId: 'glm-5.2', aliases: ['glm-5.2'], context: null, path: '/opencode-go/glm-5.2', npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', expectedTransport: { npm: '@ai-sdk/openai-compatible', modelFormat: 'openai', protocol: 'http-loopback', endpoint: 'chat.completions', requestPathSuffix: '/chat/completions', useResponsesLite: false, preferWebSockets: false } },
  { providerId: 'opencode-go', modelId: 'qwen3.8-max', upstreamModelId: 'qwen3.8-max', aliases: ['qwen3.8-max'], context: null, path: '/opencode-go/qwen3.8-max', npm: '@ai-sdk/anthropic', modelFormat: 'anthropic', expectedTransport: { npm: '@ai-sdk/anthropic', modelFormat: 'anthropic', protocol: 'http-loopback', endpoint: 'messages', requestPathSuffix: '/v1/messages', useResponsesLite: false, preferWebSockets: false } },
];

export const CANDIDATE_ROUTE_ROWS: readonly CandidateRouteRow[] = CANDIDATE_ROUTE_DEFINITIONS.map(row => ({
  ...row,
  upstreamId: row.upstreamModelId,
  contextWindow: row.context,
  expectedTransport: { ...row.expectedTransport, transport: CANDIDATE_TRANSPORT_NAME },
}));

const routeByPair = new Map(CANDIDATE_ROUTE_ROWS.map(row => [`${row.providerId}\0${row.modelId}`, row]));
const routeByPath = new Map(CANDIDATE_ROUTE_ROWS.map(row => [row.path, row]));
function finalPath(row: CandidateRouteRow): string {
  return `${row.path}${row.expectedTransport.requestPathSuffix}`;
}

const routeByFinalPath = new Map(CANDIDATE_ROUTE_ROWS.map(row => [finalPath(row), row]));
let candidateProtectedOpenHook: ((path: string) => void) | undefined;

export function setCandidateProtectedOpenHook(hook: ((path: string) => void) | undefined): void {
  candidateProtectedOpenHook = hook;
}

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'providers', 'importedAt', 'pricingCacheAt']);
const PROVIDER_KEYS = new Set(['id', 'templateId', 'name', 'enabled', 'authRef', 'authType', 'subscriptionFilter', 'api', 'modelsCache', 'addedAt', 'refreshedAt']);
const API_KEYS = new Set(['npm', 'url', 'id']);
const CACHE_KEYS = new Set(['fetchedAt', 'models']);
const MODEL_KEYS = new Set(['id', 'name', 'upstreamModelId', 'family', 'brand', 'contextWindow', 'cost', 'usageMultiplier', 'usageMultiplierApplies', 'deprecated', 'contextWindowUnconfirmed', 'isFree', 'freeStatus', 'modelFormat', 'npm', 'apiUrl', 'sourceBackend', 'supportedParameters', 'reasoning', 'interleavedReasoningField', 'useResponsesLite', 'preferWebSockets']);
const COST_KEYS = new Set(['input', 'output', 'cache_read', 'cache_write']);
const CREDENTIAL_KEY = /(?:api.?key|access.?token|refresh.?token|credential|secret|password|cookie|authorization|bearer|keyring|oauth.?token|(?:^|[_-])key(?:$|[_-]))/i;
const CANDIDATE_ENV_ALLOWLIST = new Set([
  'HOME',
  'CANDIDATE_HOME',
  'CANDIDATE_CONFIG',
  'CANDIDATE_LEVERFRAME_PROVIDERS',
  'LEVERFRAME_HOME',
  'LEVERFRAME_CANDIDATE_MODE',
  'LEVERFRAME_TEST_TRANSPORT',
  'LEVERFRAME_TEST_BUILD',
  'LEVERFRAME_TEST_CLI',
  'LEVERFRAME_PRODUCTION_BUILD',
]);
const INHERITED_CREDENTIAL_ENV_KEY = /(?:api[_-]?key|auth(?:entication)?[_-]?(?:token|key)|access[_-]?token|refresh[_-]?token|secret|password|credential|cookie|bearer|oauth|keyring|ssh_auth_sock|npm[_-]?token|proxy|(?:^|[_-])(?:key|token)(?:$|[_-]))/i;

export interface CandidateEnvironment {
  readonly candidateHome: string;
  readonly appHome: string;
  readonly configRoot: string;
  readonly registryPath: string;
  readonly resolverAuditPath: string;
}

export interface CandidateFixtureValidationOptions { requireAllRoutes?: boolean }
export interface CandidateEnvironmentValidationOptions { requireRegistry?: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Candidate registry ${label} contains unsupported key: ${key}`);
}

function assertNoCredentialMaterial(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentialMaterial(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'authRef' && CREDENTIAL_KEY.test(key)) throw new Error(`Candidate registry contains credential material at ${path}.${key}`);
    if (key.toLowerCase().includes('header')) throw new Error(`Candidate registry contains headers at ${path}.${key}`);
    if (key !== 'authRef' && typeof child === 'string' && /^(?:sk-|nvapi-|bearer\s|token[-_]|secret[-_])/i.test(child)) throw new Error(`Candidate registry contains credential-shaped value at ${path}.${key}`);
    assertNoCredentialMaterial(child, `${path}.${key}`);
  }
}

function loopbackUrl(value: unknown, label: string): URL {
  if (typeof value !== 'string' || !value) throw new Error(`Candidate registry ${label} must be a URL`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Candidate registry ${label} must be a loopback URL`); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== CANDIDATE_HOST || parsed.port !== String(UPSTREAM_MOCK_PORT) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname === '/') {
    throw new Error(`Candidate registry ${label} must use loopback port ${UPSTREAM_MOCK_PORT} without redirects`);
  }
  if (!routeByPath.has(parsed.pathname)) throw new Error(`Candidate registry ${label} path is not in the route allowlist: ${parsed.pathname}`);
  return parsed;
}

function validateCost(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`Candidate registry ${label}.cost must be an object`);
  assertOnlyKeys(value, COST_KEYS, `${label}.cost`);
  for (const [key, child] of Object.entries(value)) if (typeof child !== 'number' || !Number.isFinite(child) || child < 0) throw new Error(`Candidate registry ${label}.cost.${key} must be a non-negative number`);
}

function validateCachedModel(value: unknown, providerId: string): CachedModel {
  if (!isRecord(value)) throw new Error(`Candidate registry ${providerId} has an invalid CachedModel`);
  assertOnlyKeys(value, MODEL_KEYS, `CachedModel for ${providerId}`);
  for (const key of ['id', 'name', 'upstreamModelId', 'modelFormat']) if (typeof value[key] !== 'string' || !value[key]) throw new Error(`Candidate registry CachedModel.${key} must be a string`);
  if (value.modelFormat !== 'anthropic' && value.modelFormat !== 'openai' && value.modelFormat !== 'cloud-code') throw new Error(`Candidate registry CachedModel.modelFormat is unsupported: ${String(value.modelFormat)}`);
  if (value.npm !== undefined && value.npm !== '@ai-sdk/anthropic' && value.npm !== '@ai-sdk/openai-compatible' && value.npm !== '@ai-sdk/openai') throw new Error(`Candidate registry CachedModel.npm is unsupported: ${String(value.npm)}`);
  if (value.apiUrl === undefined) throw new Error(`Candidate registry CachedModel.apiUrl is required for ${providerId}`);
  const apiUrl = loopbackUrl(value.apiUrl, `CachedModel ${providerId}.apiUrl`);
  const row = routeByPair.get(`${providerId}\0${value.id}`);
  if (!row || apiUrl.pathname !== row.path) throw new Error(`Candidate registry has no route row for ${providerId}:${value.id}`);
  if (value.upstreamModelId !== row.upstreamModelId) throw new Error(`Candidate registry upstreamModelId mismatch for ${providerId}:${value.id}`);
  if ((value.npm ?? row.npm) !== row.npm) throw new Error(`Candidate registry npm mismatch for ${providerId}:${value.id}`);
  if (value.modelFormat !== row.modelFormat) throw new Error(`Candidate registry modelFormat mismatch for ${providerId}:${value.id}`);
  if (row.context !== null && value.contextWindow !== row.context) throw new Error(`Candidate registry contextWindow mismatch for ${providerId}:${value.id}`);
  if (row.context === null && value.contextWindow !== undefined) throw new Error(`Candidate registry contextWindow must be unconfirmed for ${providerId}:${value.id}`);
  if (value.useResponsesLite !== undefined && value.useResponsesLite !== row.expectedTransport.useResponsesLite) throw new Error(`Candidate registry useResponsesLite mismatch for ${providerId}:${value.id}`);
  if (value.preferWebSockets !== undefined && value.preferWebSockets !== row.expectedTransport.preferWebSockets) throw new Error(`Candidate registry preferWebSockets mismatch for ${providerId}:${value.id}`);
  const optionalStrings = ['family', 'brand', 'freeStatus', 'sourceBackend', 'interleavedReasoningField'];
  for (const key of optionalStrings) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Candidate registry CachedModel.${key} must be a string`);
  const optionalNumbers = ['contextWindow', 'usageMultiplier'];
  for (const key of optionalNumbers) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new Error(`Candidate registry CachedModel.${key} must be a number`);
  const optionalBooleans = ['usageMultiplierApplies', 'deprecated', 'contextWindowUnconfirmed', 'isFree', 'reasoning', 'useResponsesLite', 'preferWebSockets'];
  for (const key of optionalBooleans) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`Candidate registry CachedModel.${key} must be boolean`);
  if (value.cost !== undefined) validateCost(value.cost, `CachedModel ${providerId}:${value.id}`);
  if (value.supportedParameters !== undefined && (!Array.isArray(value.supportedParameters) || value.supportedParameters.some(item => typeof item !== 'string'))) throw new Error(`Candidate registry supportedParameters must be a string array for ${providerId}:${value.id}`);
  return value as unknown as CachedModel;
}

function validateProvider(value: unknown): RegistryProvider {
  if (!isRecord(value)) throw new Error('Candidate registry provider must be an object');
  assertOnlyKeys(value, PROVIDER_KEYS, 'provider');
  for (const key of ['id', 'templateId', 'name', 'authRef', 'addedAt']) if (typeof value[key] !== 'string' || !value[key]) throw new Error(`Candidate registry provider.${key} must be a string`);
  if (typeof value.enabled !== 'boolean') throw new Error('Candidate registry provider.enabled must be boolean');
  if (value.authRef !== 'none:anonymous') throw new Error('Candidate registry authRef must equal none:anonymous');
  if (value.authType !== 'none') throw new Error('Candidate registry authType must equal none');
  const providerId = value.id as string;
  if (value.subscriptionFilter !== undefined && value.subscriptionFilter !== 'free') throw new Error('Candidate registry subscriptionFilter is unsupported');
  if (!isRecord(value.api)) throw new Error(`Candidate registry api is required for ${providerId}`);
  assertOnlyKeys(value.api, API_KEYS, `provider ${providerId}.api`);
  for (const [key, child] of Object.entries(value.api)) if (typeof child !== 'string') throw new Error(`Candidate registry provider ${providerId}.api.${key} must be a string`);
  if (value.api.npm !== '@ai-sdk/anthropic' && value.api.npm !== '@ai-sdk/openai-compatible' && value.api.npm !== '@ai-sdk/openai') throw new Error(`Candidate registry provider ${providerId}.api.npm is unsupported`);
  const providerUrl = loopbackUrl(value.api.url, `provider ${providerId}.api.url`);
  if (!isRecord(value.modelsCache) || typeof value.modelsCache.fetchedAt !== 'string' || !Array.isArray(value.modelsCache.models)) throw new Error(`Candidate registry modelsCache is required for ${providerId}`);
  const cache = value.modelsCache;
  assertOnlyKeys(cache, CACHE_KEYS, `provider ${providerId}.modelsCache`);
  const models = (cache.models as unknown[]).map(model => validateCachedModel(model, providerId));
  if (models.length === 0) throw new Error(`Candidate registry provider ${providerId} has no cached models`);
  const modelPaths = new Set(models.map(model => routeByPair.get(`${providerId}\0${model.id}`)?.path));
  if (!modelPaths.has(providerUrl.pathname)) throw new Error(`Candidate registry api.url does not match a model route for ${providerId}`);
  if (value.refreshedAt !== undefined && typeof value.refreshedAt !== 'string') throw new Error(`Candidate registry refreshedAt must be a string for ${providerId}`);
  return value as unknown as RegistryProvider;
}

export function strictValidateCandidateFixture(input: unknown, options: CandidateFixtureValidationOptions = {}): ProviderRegistry {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      try { value = JSON.parse(readFileSync(input, 'utf8')) as unknown; } catch (error) { throw new Error(`Candidate registry is not valid JSON: ${input}`, { cause: error }); }
    }
  } else if (input instanceof Uint8Array) {
    try { value = JSON.parse(Buffer.from(input).toString('utf8')) as unknown; } catch (error) { throw new Error('Candidate registry bytes are not valid JSON', { cause: error }); }
  }
  if (!isRecord(value)) throw new Error('Candidate registry must be a JSON object');
  assertOnlyKeys(value, TOP_LEVEL_KEYS, 'root');
  if (value.schemaVersion !== 1) throw new Error('Candidate registry schemaVersion must equal 1');
  if (!Array.isArray(value.providers) || value.providers.length === 0) throw new Error('Candidate registry providers must be a non-empty array');
  if (value.importedAt !== undefined && typeof value.importedAt !== 'string') throw new Error('Candidate registry importedAt must be a string');
  if (value.pricingCacheAt !== undefined && typeof value.pricingCacheAt !== 'string') throw new Error('Candidate registry pricingCacheAt must be a string');
  assertNoCredentialMaterial(value);
  const providers = value.providers.map(validateProvider);
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`Candidate registry contains duplicate provider: ${provider.id}`);
    seen.add(provider.id);
  }
  if (options.requireAllRoutes) {
    const actual = new Set(providers.flatMap(provider => provider.modelsCache?.models.map(model => `${provider.id}\0${model.id}`) ?? []));
    for (const row of CANDIDATE_ROUTE_ROWS) if (!actual.has(`${row.providerId}\0${row.modelId}`)) throw new Error(`Candidate registry is missing route row ${row.providerId}:${row.modelId}`);
  }
  return { schemaVersion: 1, providers, ...(typeof value.importedAt === 'string' ? { importedAt: value.importedAt } : {}), ...(typeof value.pricingCacheAt === 'string' ? { pricingCacheAt: value.pricingCacheAt } : {}) };
}

export function sanitizeCandidateRegistry(source: ProviderRegistry): ProviderRegistry {
  const sourceById = new Map(source.providers.map(provider => [provider.id, provider]));
  const providers = new Map<string, RegistryProvider>();
  for (const row of CANDIDATE_ROUTE_ROWS) {
    const sourceProvider = sourceById.get(row.providerId);
    const sourceCache = sourceProvider?.modelsCache;
    const sourceModel = sourceCache?.models.find(model => model.id === row.modelId);
    if (!sourceProvider || !sourceCache || !sourceModel) throw new Error(`Candidate source registry is missing ${row.providerId}:${row.modelId}`);
    const existing = providers.get(row.providerId);
    const model = {
      ...sourceModel,
      upstreamModelId: row.upstreamModelId,
      modelFormat: row.modelFormat,
      npm: row.npm,
      apiUrl: `http://${CANDIDATE_HOST}:${UPSTREAM_MOCK_PORT}${row.path}`,
      ...(row.context === null ? { contextWindow: undefined, contextWindowUnconfirmed: true } : { contextWindow: row.context, contextWindowUnconfirmed: undefined }),
      ...(row.expectedTransport.useResponsesLite ? { useResponsesLite: true } : { useResponsesLite: undefined }),
      ...(row.expectedTransport.preferWebSockets ? { preferWebSockets: true } : { preferWebSockets: undefined }),
    };
    if (existing) {
      existing.modelsCache?.models.push(model);
      continue;
    }
    providers.set(row.providerId, {
      id: sourceProvider.id,
      templateId: sourceProvider.templateId,
      name: sourceProvider.name,
      enabled: sourceProvider.enabled,
      authRef: 'none:anonymous',
      authType: 'none',
      ...(sourceProvider.subscriptionFilter ? { subscriptionFilter: sourceProvider.subscriptionFilter } : {}),
      api: { npm: row.npm, url: `http://${CANDIDATE_HOST}:${UPSTREAM_MOCK_PORT}${row.path}` },
      modelsCache: { fetchedAt: sourceCache.fetchedAt, models: [model] },
      addedAt: sourceProvider.addedAt,
      ...(sourceProvider.refreshedAt ? { refreshedAt: sourceProvider.refreshedAt } : {}),
    });
  }
  return strictValidateCandidateFixture({ schemaVersion: 1, providers: [...providers.values()] }, { requireAllRoutes: true });
}

function pathContained(child: string, parent: string, allowEqual = false): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return (allowEqual && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${'/'}`) && !isAbsolute(rel));
}

function realPath(path: string): string | null {
  try { return realpathSync.native(path); } catch { return null; }
}

function realPathContained(child: string, parent: string, allowEqual = false): boolean {
  const realChild = realPath(child);
  const realParent = realPath(parent);
  return realChild !== null && realParent !== null && pathContained(realChild, realParent, allowEqual);
}

function regularDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory() && statSync(path).isDirectory() && realPath(path) !== null; } catch { return false; }
}

function regularFile(path: string): boolean {
  try { return lstatSync(path).isFile() && realPath(path) !== null; } catch { return false; }
}

function nearestExistingPath(path: string): string | null {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return realPath(current);
}

function anyCandidateVariable(env: NodeJS.ProcessEnv): boolean {
  return [...CANDIDATE_ENV_ALLOWLIST].some(name => env[name] !== undefined && name !== 'HOME');
}

function assertCandidateEnvironmentAllowlist(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (INHERITED_CREDENTIAL_ENV_KEY.test(name)) throw new Error(`Candidate environment rejects inherited credential variable: ${name}`);
    if ((name.startsWith('LEVERFRAME_') || name.startsWith('CANDIDATE_')) && !CANDIDATE_ENV_ALLOWLIST.has(name)) {
      throw new Error(`Candidate environment variable is not allowlisted: ${name}`);
    }
  }
}

export function validateCandidateLoopbackEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: CandidateEnvironmentValidationOptions = {},
): CandidateEnvironment | null {
  if (!anyCandidateVariable(env)) return null;
  assertCandidateEnvironmentAllowlist(env);
  if (env.LEVERFRAME_PRODUCTION_BUILD === '1') throw new Error('Candidate transport is unavailable in the production build');
  if (env.LEVERFRAME_CANDIDATE_MODE !== '1') throw new Error('Candidate mode requires LEVERFRAME_CANDIDATE_MODE=1');
  if (env.LEVERFRAME_TEST_TRANSPORT !== CANDIDATE_TRANSPORT_NAME) throw new Error(`Candidate mode requires LEVERFRAME_TEST_TRANSPORT=${CANDIDATE_TRANSPORT_NAME}`);
  if (env.LEVERFRAME_TEST_BUILD !== '1') throw new Error('Candidate mode requires LEVERFRAME_TEST_BUILD=1');
  const candidateHome = env.CANDIDATE_HOME;
  if (!candidateHome || !env.HOME || env.HOME !== candidateHome || !regularDirectory(candidateHome)) throw new Error('Candidate mode requires HOME to equal a regular CANDIDATE_HOME directory');
  const realCandidateHome = realPath(candidateHome);
  const realTempRoot = realPath(tmpdir());
  if (!realCandidateHome || !realTempRoot || !pathContained(realCandidateHome, realTempRoot, true) || realCandidateHome === realTempRoot) throw new Error('Candidate mode requires CANDIDATE_HOME to be a private temporary root');
  const appHome = env.LEVERFRAME_HOME;
  if (!appHome || !regularDirectory(appHome) || !realPathContained(appHome, realCandidateHome)) throw new Error('Candidate mode requires LEVERFRAME_HOME to be a regular directory below CANDIDATE_HOME');
  const configRoot = env.CANDIDATE_CONFIG;
  if (!configRoot || !regularDirectory(configRoot) || !realPathContained(configRoot, realCandidateHome, true)) throw new Error('Candidate mode requires CANDIDATE_CONFIG below CANDIDATE_HOME');
  const realAppHome = realPath(appHome);
  const realConfigRoot = realPath(configRoot);
  if (!realAppHome || !realConfigRoot) throw new Error('Candidate mode requires realpath-verifiable roots');
  const registryPath = env.CANDIDATE_LEVERFRAME_PROVIDERS ?? join(appHome, 'providers.json');
  if (!pathContained(registryPath, appHome) || (existsSync(registryPath) && !realPathContained(registryPath, realAppHome)) || (options.requireRegistry !== false && (!existsSync(registryPath) || !regularFile(registryPath)))) throw new Error(`Candidate registry is missing, outside LEVERFRAME_HOME, or not a regular file: ${registryPath}`);
  return { candidateHome: realCandidateHome, appHome: realAppHome, configRoot: realConfigRoot, registryPath: realPath(registryPath) ?? registryPath, resolverAuditPath: join(realConfigRoot, 'logs', 'resolver-audit.json') };
}

export interface ResolverAuditCounts {
  readonly resolveProviderCredentialCalls: 0;
  readonly resolveProviderOAuthAccountIdCalls: 0;
  readonly resolveProviderOAuthProviderDataCalls: 0;
}

const ZERO_RESOLVER_AUDIT_COUNTS: ResolverAuditCounts = Object.freeze({
  resolveProviderCredentialCalls: 0,
  resolveProviderOAuthAccountIdCalls: 0,
  resolveProviderOAuthProviderDataCalls: 0,
});

export function getResolverAuditCounts(): ResolverAuditCounts {
  return { ...ZERO_RESOLVER_AUDIT_COUNTS };
}

export interface ResolverAuditRecord {
  schemaVersion: 1;
  processId: number;
  startedAt: string;
  endedAt: string;
  candidateMode: true;
  testBuild: true;
  transport: typeof CANDIDATE_TRANSPORT_NAME;
  counts: ResolverAuditCounts;
  routes?: readonly CandidateRouteAudit[];
  auditSha256?: string;
  finalAuditSha256?: string;
}

export interface CandidateRouteAudit {
  route: string;
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
  requestSha256: string;
  responseSha256: string;
  outputHash: string;
  ordinal: number;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function setDescriptorMode(fd: number, mode: number, label: string): void {
  fchmodSync(fd, mode);
  if ((fstatSync(fd).mode & 0o777) !== mode) throw new Error(`Candidate ${label} permission verification failed`);
}

function secureAuditPath(path: string, candidate: CandidateEnvironment): string {
  const parent = dirname(path);
  if (path !== candidate.resolverAuditPath || !pathContained(path, candidate.configRoot)) {
    throw new Error(`Candidate audit path is outside CANDIDATE_CONFIG: ${path}`);
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!regularDirectory(parent) || !realPathContained(parent, candidate.configRoot)) throw new Error(`Candidate audit parent is not a regular contained directory: ${parent}`);
  chmodSync(parent, 0o700);
  return parent;
}

function openContainedRegularFile(path: string, candidate: CandidateEnvironment, flags: number): number {
  if (existsSync(path)) {
    let current: ReturnType<typeof lstatSync>;
    try { current = lstatSync(path); } catch (error) { throw new Error(`Candidate file cannot be inspected: ${path}`, { cause: error }); }
    if (!current.isFile()) throw new Error(`Candidate file must be a regular non-symlink file: ${path}`);
  }
  const fd = openSync(path, flags | fsConstants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Candidate file is not regular after open: ${path}`);
    const openedPath = realPath(path);
    if (!openedPath || !realPathContained(openedPath, candidate.configRoot)) {
      throw new Error(`Candidate file escaped CANDIDATE_CONFIG after open: ${path}`);
    }
    candidateProtectedOpenHook?.(path);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

const PROVENANCE_LOCK_TIMEOUT_MS = 5_000;
const PROVENANCE_LOCK_STALE_MS = 30_000;

interface ProvenanceLock {
  readonly fd: number;
  readonly path: string;
  readonly parent: string;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lockProcessAlive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function staleLock(path: string, observed: Stats): boolean {
  if (Date.now() - observed.mtimeMs < PROVENANCE_LOCK_STALE_MS) return false;
  let fd: number;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { return false; }
  try {
    const current = fstatSync(fd) as Stats;
    if (!sameFileIdentity(observed, current) || !current.isFile()) return false;
    let metadata: unknown;
    try { metadata = JSON.parse(readFileSync(fd, 'utf8')) as unknown; } catch { return true; }
    return !isRecord(metadata) || !lockProcessAlive(metadata.pid);
  } finally { closeSync(fd); }
}

function removeLockIfUnchanged(path: string, parent: string, observed: Stats): boolean {
  let current: Stats;
  try { current = lstatSync(path) as Stats; } catch { return false; }
  if (!current.isFile() || !sameFileIdentity(current, observed)) return false;
  unlinkSync(path);
  fsyncDirectory(parent);
  return true;
}

async function acquireProvenanceLock(path: string, candidate: CandidateEnvironment): Promise<ProvenanceLock> {
  const parent = dirname(path);
  if (!realPathContained(parent, candidate.configRoot, true)) throw new Error(`Candidate provenance lock is outside CANDIDATE_CONFIG: ${path}`);
  const deadline = Date.now() + PROVENANCE_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        if (!fstatSync(fd).isFile()) throw new Error(`Candidate provenance lock is not a regular file: ${path}`);
        setDescriptorMode(fd, 0o600, 'provenance lock');
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
        fsyncSync(fd);
        fsyncDirectory(parent);
        return { fd, path, parent };
      } catch (error) {
        closeSync(fd);
        try { unlinkSync(path); } catch { }
        throw error;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      let observed: Stats;
      try { observed = lstatSync(path) as Stats; } catch { continue; }
      if (!observed.isFile()) throw new Error(`Candidate provenance lock must be a regular non-symlink file: ${path}`);
      if (staleLock(path, observed)) {
        removeLockIfUnchanged(path, parent, observed);
        continue;
      }
      await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 5));
    }
  }
  throw new Error(`Candidate provenance lock acquisition timed out: ${path}`);
}

function releaseProvenanceLock(lock: ProvenanceLock): void {
  try {
    const pathStat = lstatSync(lock.path) as Stats;
    if (!sameFileIdentity(pathStat, fstatSync(lock.fd) as Stats)) throw new Error(`Candidate provenance lock ownership changed: ${lock.path}`);
    unlinkSync(lock.path);
    fsyncDirectory(lock.parent);
  } finally {
    closeSync(lock.fd);
  }
}

function readProvenanceNextOrdinal(path: string, candidate: CandidateEnvironment): number {
  let fd: number;
  try { fd = openContainedRegularFile(path, candidate, fsConstants.O_RDONLY); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let previous = '';
  try { previous = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  let nextOrdinal = 0;
  for (const line of previous.split('\n').filter(Boolean)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; } catch (error) { throw new Error('Candidate provenance sidecar contains invalid JSON', { cause: error }); }
    if (!isRecord(parsed) || !Number.isSafeInteger(parsed.ordinal) || parsed.ordinal !== nextOrdinal) throw new Error('Candidate provenance sidecar ordinals are not globally monotonic and unique');
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

export function writeResolverAudit(path: string, record: ResolverAuditRecord): void {
  const candidate = validateCandidateLoopbackEnvironment(process.env, { requireRegistry: false });
  if (!candidate) throw new Error('Resolver audit requires candidate environment gates');
  const parent = secureAuditPath(path, candidate);
  const unsigned = { ...record };
  delete unsigned.auditSha256;
  delete unsigned.finalAuditSha256;
  const digest = createHash('sha256').update(`${JSON.stringify(unsigned)}\n`).digest('hex');
  const finalRecord = { ...unsigned, auditSha256: digest, finalAuditSha256: digest };
  const fd = openContainedRegularFile(path, candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC);
  try { writeFileSync(fd, `${JSON.stringify(finalRecord)}\n`, 'utf8'); setDescriptorMode(fd, 0o600, 'audit'); fsyncSync(fd); } finally { closeSync(fd); }
  fsyncDirectory(parent);
}

export const CANDIDATE_PROVENANCE_EVENT_CLASSES = ['request', 'response', 'tool', 'error'] as const;
export type CandidateProvenanceEventClass = typeof CANDIDATE_PROVENANCE_EVENT_CLASSES[number];
export interface CandidateProvenanceRecord {
  eventClass: CandidateProvenanceEventClass;
  invocationId: string;
  sourcePromptId: string;
  route: string;
  byteSpan: { start: number; end: number };
  jsonPath: string;
  inputHash: string;
  normalizedInputHash: string;
  outputHash: string;
  routeRowSha256: string;
  upstream: {
    providerId: string;
    modelId: string;
    upstreamModelId: string;
    upstreamId: string;
  };
  upstreamModelId: string;
  upstreamId: string;
  aliases: readonly string[];
  context: number | null;
  transport: CandidateRouteRow['expectedTransport'];
  ordinal?: number;
}
export interface CandidateProvenanceHook { beforeTransport(record: CandidateProvenanceRecord): Promise<number> }

export function createCandidateProvenanceHook(path: string): CandidateProvenanceHook {
  return { beforeTransport: async record => {
    const candidate = validateCandidateLoopbackEnvironment(process.env, { requireRegistry: false });
    if (!candidate) throw new Error('Candidate provenance requires candidate environment gates');
    const parent = dirname(path);
    const existingParent = nearestExistingPath(parent);
    if (!existingParent || !pathContained(existingParent, candidate.configRoot, true)) throw new Error(`Candidate provenance parent is outside CANDIDATE_CONFIG: ${parent}`);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const realParent = realPath(parent);
    if (!regularDirectory(parent) || !realParent || !pathContained(realParent, candidate.configRoot, true)) throw new Error(`Candidate provenance parent is not a regular contained directory: ${parent}`);
    const lock = await acquireProvenanceLock(`${path}.lock`, candidate);
    try {
      const nextOrdinal = readProvenanceNextOrdinal(path, candidate);
    const eventClass = record.eventClass;
    if (!(CANDIDATE_PROVENANCE_EVENT_CLASSES as readonly string[]).includes(eventClass)) throw new Error(`Candidate provenance event class is not allowed: ${String(eventClass)}`);
    const route = record.route;
    const row = routeByFinalPath.get(route) ?? routeByPath.get(route);
    if (!row) throw new Error(`Candidate provenance route is not in the route allowlist: ${route}`);
    if (JSON.stringify(record.upstream) !== JSON.stringify({ providerId: row.providerId, modelId: row.modelId, upstreamModelId: row.upstreamModelId, upstreamId: row.upstreamId })) throw new Error('Candidate provenance upstream metadata is invalid');
    if (record.upstreamModelId !== row.upstreamModelId || record.upstreamId !== row.upstreamId) throw new Error('Candidate provenance upstream identifiers are invalid');
    if (JSON.stringify(record.aliases) !== JSON.stringify(row.aliases)) throw new Error('Candidate provenance aliases are invalid');
    if (record.context !== row.context) throw new Error('Candidate provenance context is invalid');
    if (JSON.stringify(record.transport) !== JSON.stringify(row.expectedTransport)) throw new Error('Candidate provenance transport metadata is invalid');
    const byteSpan = record.byteSpan;
    if (!Number.isSafeInteger(byteSpan.start) || !Number.isSafeInteger(byteSpan.end) || byteSpan.start < 0 || byteSpan.end < byteSpan.start) throw new Error('Candidate provenance byte span is invalid');
    const jsonPath = record.jsonPath;
    if (!/^\$(?:(?:\.[A-Za-z_$][A-Za-z0-9_$]*)|(?:\[(?:0|[1-9][0-9]*)\])|(?:\[(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\]))*$/.test(jsonPath)) throw new Error('Candidate provenance JSON path is invalid');
    const ordinal = record.ordinal ?? nextOrdinal;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal !== nextOrdinal) throw new Error(`Candidate provenance ordinal must be globally monotonic and unique, expected ${nextOrdinal}`);
    for (const [name, hash] of Object.entries({ inputHash: record.inputHash, normalizedInputHash: record.normalizedInputHash, outputHash: record.outputHash, routeRowSha256: record.routeRowSha256 })) {
      if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error(`Candidate provenance ${name} is not an exact 64-hex hash`);
    }
    const normalized = {
      ...record,
      eventClass,
      route,
      byteSpan,
      jsonPath,
      ordinal,
    };
    chmodSync(parent, 0o700);
    const fd = openContainedRegularFile(path, candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);
    try { writeFileSync(fd, `${JSON.stringify(normalized)}\n`, 'utf8'); setDescriptorMode(fd, 0o600, 'provenance'); fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDirectory(parent);
    return ordinal;
    } finally {
      releaseProvenanceLock(lock);
    }
  } };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', chunk => {
      const data = Buffer.from(chunk);
      total += data.length;
      if (total > 2 * 1024 * 1024) { req.destroy(new Error('Candidate request exceeds 2 MiB')); reject(new Error('Candidate request exceeds 2 MiB')); return; }
      chunks.push(data);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function candidateBody(req: IncomingMessage): Promise<Buffer> {
  const body = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')) as unknown; } catch { throw new Error('Candidate request body must be JSON'); }
  if (!req.headers['x-leverframe-candidate-marker'] || req.headers['x-leverframe-candidate-marker'] !== CANDIDATE_MARKER) throw new Error('Candidate request marker is invalid');
  if (!isRecord(parsed)) throw new Error('Candidate request body must be an object');
  return body;
}

function mockResponse(row: CandidateRouteRow): Record<string, unknown> {
  if (row.modelFormat === 'anthropic') return { id: `candidate-${row.providerId}-${row.modelId}`, type: 'message', role: 'assistant', model: row.modelId, content: [{ type: 'text', text: `candidate-response:${row.providerId}:${row.modelId}` }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  if (row.expectedTransport.endpoint === 'responses') return { id: `candidate-${row.providerId}-${row.modelId}`, object: 'response', model: row.modelId, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `candidate-response:${row.providerId}:${row.modelId}` }] }] };
  return { id: `candidate-${row.providerId}-${row.modelId}`, object: 'chat.completion', model: row.modelId, choices: [{ index: 0, message: { role: 'assistant', content: `candidate-response:${row.providerId}:${row.modelId}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

async function listenFixed(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(new Error(`Candidate transport could not bind 127.0.0.1:${port}`, { cause: error })); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, CANDIDATE_HOST);
  });
}

export interface CandidateTransportHandle { readonly candidatePort: number; readonly upstreamPort: number; close(): Promise<void> }
export interface CandidateTransportOptions { provenance?: CandidateProvenanceHook }

export async function startCandidateLoopbackTransport(_options: CandidateTransportOptions = {}): Promise<CandidateTransportHandle> {
  const transportEnv = validateCandidateLoopbackEnvironment(process.env, { requireRegistry: false });
  if (!transportEnv) throw new Error('Candidate transport requires candidate environment gates');
  const upstream = createServer(async (req, res) => {
    const row = routeByFinalPath.get(req.url?.split('?')[0] ?? '');
    if (!row || req.method !== 'POST' || req.url?.includes('?')) { sendJson(res, 404, { error: { message: 'candidate route not found' } }); return; }
    try { await candidateBody(req); sendJson(res, 200, mockResponse(row)); } catch (error) { sendJson(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } }); }
  });
  const candidate = createServer(async (req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const row = routeByFinalPath.get(path);
    if (!row || req.method !== 'POST' || req.url?.includes('?')) { sendJson(res, 404, { error: { message: 'candidate route not found' } }); return; }
    try {
      const body = await candidateBody(req);
      const upstreamResponse = await new Promise<{ statusCode: number; body: Buffer }>((resolveResponse, reject) => {
          const forward = httpRequest({ agent: false, hostname: CANDIDATE_HOST, port: UPSTREAM_MOCK_PORT, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.byteLength, 'x-leverframe-candidate-marker': CANDIDATE_MARKER } }, response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(Buffer.from(chunk)));
          response.on('end', () => resolveResponse({ statusCode: response.statusCode ?? 502, body: Buffer.concat(chunks) }));
        });
        forward.on('error', reject); forward.end(body);
      });
      res.writeHead(upstreamResponse.statusCode, { 'content-type': 'application/json', 'content-length': upstreamResponse.body.byteLength }); res.end(upstreamResponse.body);
    } catch (error) { sendJson(res, 502, { error: { message: error instanceof Error ? error.message : String(error) } }); }
  });
  try { await listenFixed(upstream, UPSTREAM_MOCK_PORT); await listenFixed(candidate, CANDIDATE_LISTENER_PORT); } catch (error) {
    await Promise.allSettled([new Promise<void>(done => upstream.close(() => done())), new Promise<void>(done => candidate.close(() => done()))]);
    throw error;
  }
  return {
    candidatePort: CANDIDATE_LISTENER_PORT,
    upstreamPort: UPSTREAM_MOCK_PORT,
    close: async () => { await Promise.all([new Promise<void>(done => candidate.close(() => done())), new Promise<void>(done => upstream.close(() => done()))]); },
  };
}

export interface CandidateRequestOptions { provenance?: CandidateProvenanceHook; provenanceRecord?: CandidateProvenanceRecord }

export async function requestCandidateLoopback(path: string, body: unknown, options: CandidateRequestOptions = {}): Promise<{ statusCode: number; body: string }> {
  const requestEnv = validateCandidateLoopbackEnvironment(process.env, { requireRegistry: false });
  if (!requestEnv) throw new Error('Candidate request requires candidate environment gates');
  const row = routeByPath.get(path) ?? routeByFinalPath.get(path);
  if (!row) throw new Error(`Unknown candidate route: ${path}`);
  const final = routeByFinalPath.has(path) ? path : finalPath(row);
  const requestOrdinal = options.provenance && options.provenanceRecord ? await options.provenance.beforeTransport(options.provenanceRecord) : undefined;
  const payload = JSON.stringify(isRecord(body) ? body : { value: body });
  return new Promise((resolveResponse, reject) => {
    const req = httpRequest({ agent: false, hostname: CANDIDATE_HOST, port: CANDIDATE_LISTENER_PORT, path: final, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-leverframe-candidate-marker': CANDIDATE_MARKER } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', async () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        try {
          if (options.provenance && options.provenanceRecord) {
            await options.provenance.beforeTransport({
              ...options.provenanceRecord,
              eventClass: 'response',
              byteSpan: { start: 0, end: Buffer.byteLength(responseBody) },
              jsonPath: '$',
              outputHash: createHash('sha256').update(responseBody).digest('hex'),
              ordinal: requestOrdinal === undefined ? undefined : requestOrdinal + 1,
            });
          }
          resolveResponse({ statusCode: response.statusCode ?? 502, body: responseBody });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject); req.end(payload);
  });
}

export function materializeCandidateFixture(registry: ProviderRegistry, materialize: (registry: ProviderRegistry, key: (provider: RegistryProvider) => string) => LocalProvider[]): LocalProvider[] {
  const candidate = validateCandidateLoopbackEnvironment(process.env);
  if (!candidate) throw new Error('Candidate fixture requires candidate environment gates');
  void candidate;
  return materialize(registry, () => CANDIDATE_TEST_CREDENTIAL);
}

export function loadCandidateRegistryProviders(): LocalProvider[] {
  const candidate = validateCandidateLoopbackEnvironment();
  if (!candidate) throw new Error('Candidate registry requires candidate environment gates');
  const registry = strictValidateCandidateFixture(candidate.registryPath, { requireAllRoutes: true });
  return materializeCandidateFixture(registry, materializeRegistry);
}
