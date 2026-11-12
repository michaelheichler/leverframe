import { createHash } from 'node:crypto';
import { tool, jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import type { FullStreamPart } from './proxy-shared.js';
import {
  deepMergeProviderOptions,
  effortProviderOptions,
  thinkingProviderOptions,
  type ReasoningMetadata,
} from './provider-factory.js';
import { resolveUpstreamTools } from './tool-search.js';
import type { AnthropicRequestMessage, AnthropicToolDefinition } from './proxy-types.js';
import { CLAUDE_CODE_BILLING_HEADER_PREFIX } from './oauth/claude-identity.js';
import { ToolResultImageError } from './provider-error.js';
import { VERTEX_ANTHROPIC_NPM } from './constants.js';
import { neutralClientInstructions } from './neutral-client-request.js';
import { extractClaudeSessionId } from './client-session.js';
import { anthropicCacheOptions, anthropicCacheSettings, anthropicSystemMessages, validAnthropicCacheControls, type CacheControl } from './anthropic-sdk-cache.js';
import { ANTIGRAVITY_SESSION_HEADER } from './antigravity/types.js';
import { openCodeZenHeaders } from './opencode-zen.js';
import { annotateToolNames, translateMessages, type AnthropicMsg } from './sdk-request-messages.js';

export { ToolResultImageError, extractClaudeSessionId, annotateToolNames, translateMessages };

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}
export interface AnthropicRequest {
  model: string;
  system?: string | Array<string | { text?: string; cache_control?: CacheControl }>;
  messages: AnthropicMsg[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  thinking?: { type?: string; budget_tokens?: number };
  output_config?: { effort?: string };
  metadata?: { user_id?: unknown };
  diagnostics?: unknown;
  cache_control?: CacheControl;
}

export interface TranslateRequestOptions {

  defaultEffort?: string;
  reasoningMetadata?: ReasoningMetadata;

  openAiOAuth?: boolean;

  claudeSessionId?: string;

  maxTools?: number;
}

export function claudeSessionPromptCacheKey(sessionId: string): string {
  return 'relay-session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function anthropicEffortFromRequest(body: AnthropicRequest): string | undefined {
  const effort = body.output_config?.effort;
  if (typeof effort === 'string' && effort.trim()) return effort.trim();
  return undefined;
}

export function openAiPromptCacheKey(
  system: string | undefined,
  tools: AnthropicTool[] | undefined,
): string {
  const toolSig = (tools ?? [])
    .map(t => `${t.name}\x01${t.description ?? ''}\x01${JSON.stringify(t.input_schema ?? {})}`)
    .join('\x02');
  const material = `${system ?? ''}\0${toolSig}`;
  return 'relay-' + createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function supportsOpenAiPromptCacheBreakpoints(
  _modelId: string,
  reportedSupport?: boolean,
): boolean {
  return reportedSupport === true;
}

export interface SdkCallParams {
  instructions?: string;
  messages: ModelMessage[];
  allowSystemInMessages?: boolean;
  tools?: Record<string, ReturnType<typeof tool>>;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  maxOutputTokens?: number;
  temperature?: number;
  maxRetries?: number;
  headers?: Record<string, string | undefined>;
  providerOptions?: Record<string, Record<string, unknown>>;
  inputTokensIncludeCache?: boolean;
}

function stripClaudeCodeBillingHeader(text: string): string | undefined {
  if (!text.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX)) return text;
  const newline = text.indexOf('\n');
  return newline === -1 ? undefined : text.slice(newline + 1);
}

function systemToString(
  system: AnthropicRequest['system'],
  stripAnthropicBillingHeader = false,
): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') {
    return stripAnthropicBillingHeader ? stripClaudeCodeBillingHeader(system) : system;
  }
  const blocks = system.map(b => (typeof b === 'string' ? b : b.text ?? ''));
  if (!stripAnthropicBillingHeader) return blocks.join('\n');
  return blocks.flatMap(text => {
    const stripped = stripClaudeCodeBillingHeader(text);
    return stripped === undefined ? [] : [stripped];
  }).join('\n');
}

function translateTopLevelSystemForOpenAi(
  system: AnthropicRequest['system'],
): ModelMessage[] {
  if (!system) return [];
  if (typeof system === 'string') {
    return system.trim() ? [{ role: 'system', content: system } as ModelMessage] : [];
  }
  return system.flatMap(block => {
    const text = typeof block === 'string' ? block : block.text ?? '';
    if (!text.trim()) return [];
    const cacheControl = typeof block === 'string' ? undefined : block.cache_control;
    return [{
      role: 'system',
      content: text,
      ...(cacheControl
        ? { providerOptions: { openai: { promptCacheBreakpoint: { mode: 'explicit' } } } }
        : {}),
    } as unknown as ModelMessage];
  });
}

export interface ToolInputRules {
  required: ReadonlySet<string>;
  properties: Readonly<Record<string, unknown>>;
  omitEmptyArrays: ReadonlySet<string>;
}

const EMPTY_ARRAY_OMISSION_POLICY: Readonly<Record<string, ReadonlySet<string>>> = {
  WebSearch: new Set(['allowed_domains', 'blocked_domains']),
};

function schemaAllowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return true;
  const record = schema as Record<string, unknown>;
  const type = record.type;
  if (type === 'null' || (Array.isArray(type) && type.includes('null'))) return true;
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const alternatives = record[keyword];
    if (Array.isArray(alternatives) && alternatives.some(schemaAllowsNull)) return true;
  }
  return false;
}

function schemaRequiresNonEmptyArray(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const minItems = (schema as Record<string, unknown>).minItems;
  return typeof minItems === 'number' && Number.isFinite(minItems) && minItems >= 1;
}

export function sanitizeToolInput(
  input: Record<string, unknown>,
  rules?: ToolInputRules,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const schema = rules?.properties[key];
    const required = rules?.required.has(key) ?? false;
    if (!required && schema !== undefined) {
      if (value === null && !schemaAllowsNull(schema)) continue;
      if (
        Array.isArray(value)
        && value.length === 0
        && (schemaRequiresNonEmptyArray(schema) || rules?.omitEmptyArrays.has(key))
      ) continue;
    }
    out[key] = value;
  }
  return out;
}

export function toolInputRules(tools?: SdkCallParams['tools']): Map<string, ToolInputRules> {
  const map = new Map<string, ToolInputRules>();
  for (const [name, toolDefinition] of Object.entries(tools ?? {})) {
    const schema = (toolDefinition as {
      inputSchema?: { jsonSchema?: { required?: unknown; properties?: unknown } };
    }).inputSchema?.jsonSchema;
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const properties = schema?.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, unknown>
      : {};
    map.set(name, {
      required: new Set(required.filter((item): item is string => typeof item === 'string')),
      properties,
      omitEmptyArrays: EMPTY_ARRAY_OMISSION_POLICY[name] ?? new Set(),
    });
  }
  return map;
}

export function translateTools(anthropicTools?: AnthropicTool[], anthropicCache = false): Record<string, ReturnType<typeof tool>> | undefined {
  if (!anthropicTools?.length) return undefined;
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const t of anthropicTools) {
    if (!t.name || !t.input_schema) continue;
    tools[t.name] = tool({ description: t.description ?? '', inputSchema: jsonSchema(t.input_schema),
      ...(anthropicCache && t.cache_control ? { providerOptions: anthropicCacheOptions(t.cache_control) } : {}) });
  }
  return Object.keys(tools).length ? tools : undefined;
}

export function translateToolChoice(tc: AnthropicRequest['tool_choice']): SdkCallParams['toolChoice'] {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'tool', toolName: tc.name };
  return undefined;
}

const COMPACT_TEXT_ONLY_START = 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.';
const COMPACT_TEXT_ONLY_END = 'REMINDER: Do NOT call any tools. Respond with plain text only';
const COMPACT_OAUTH_INSTRUCTION = 'Keep this compaction summary under 16,000 output tokens. Preserve concrete decisions, file paths, errors, pending tasks, and user instructions without repetition.';

/** Use prompts because StructuredOutput can be absent. */
function isClaudeCodeStructuredOutputCompactRequest(body: AnthropicRequest): boolean {
  if (body.diagnostics !== undefined) return false;

  const finalMessage = body.messages.at(-1);
  if (!finalMessage || finalMessage.role !== 'user') return false;
  const texts = typeof finalMessage.content === 'string'
    ? [finalMessage.content]
    : finalMessage.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '');
  return texts.some(text => text.startsWith(COMPACT_TEXT_ONLY_START)
    && text.includes(COMPACT_TEXT_ONLY_END));
}

const OPENAI_OAUTH_SDK_MAX_RETRIES = 0;
const SDK_MAX_RETRIES_NON_OAUTH = 1;
const CACHE_INCLUSIVE_INPUT_NPMS = new Set([
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  VERTEX_ANTHROPIC_NPM,
]);

function openAiCacheSettings(npm: string, body: AnthropicRequest, options: TranslateRequestOptions | undefined,
  sessionId: string | undefined, baseSystem: string | undefined, tools: AnthropicTool[]) {
  const upstreamModelId = options?.reasoningMetadata?.upstreamModelId ?? body.model;
  const explicit = !options?.openAiOAuth && supportsOpenAiPromptCacheBreakpoints(
    upstreamModelId, options?.reasoningMetadata?.supportsPromptCacheBreakpoints,
  );
  const key = npm === '@ai-sdk/openai'
    ? sessionId ? claudeSessionPromptCacheKey(sessionId) : openAiPromptCacheKey(baseSystem, tools)
    : undefined;
  return { explicit, key };
}

function sessionHeaders(options: TranslateRequestOptions | undefined, promptCacheKey?: string, sessionId?: string): Record<string, string> | undefined {
  if (options?.reasoningMetadata?.providerId === 'opencode-zen' && sessionId) return openCodeZenHeaders(undefined, sessionId);
  const headers: Record<string, string> = {};
  if (options?.openAiOAuth && promptCacheKey) headers['session-id'] = promptCacheKey;
  if (options?.reasoningMetadata?.providerId === 'opencode-go' && sessionId) headers['x-opencode-session'] = sessionId;
  if (options?.reasoningMetadata?.providerId === 'antigravity' && sessionId) headers[ANTIGRAVITY_SESSION_HEADER] = sessionId;
  return Object.keys(headers).length ? headers : undefined;
}

export function translateRequest(
  body: AnthropicRequest,
  npm: string,
  options?: TranslateRequestOptions,
): SdkCallParams {
  if (npm === '@ai-sdk/anthropic' && !validAnthropicCacheControls(body)) throw new TypeError('Invalid Anthropic cache_control');
  body = neutralClientInstructions(body);
  const messages = body.messages ?? [];
  annotateToolNames(messages);
  const baseSystem = systemToString(body.system, options?.openAiOAuth === true);
  const systemText = baseSystem?.trim() || (options?.openAiOAuth ? 'You are a coding assistant.' : undefined);

  const compactRequest = isClaudeCodeStructuredOutputCompactRequest(body);
  let upstreamTools = resolveUpstreamTools(
    body.tools as unknown as AnthropicToolDefinition[] | undefined,
    messages as unknown as AnthropicRequestMessage[],
  ) as unknown as AnthropicTool[];
  if (options?.maxTools !== undefined && upstreamTools.length > options.maxTools) {
    upstreamTools = upstreamTools.slice(0, options.maxTools);
  }
  const effort = anthropicEffortFromRequest(body) ?? options?.defaultEffort;
  const claudeSessionId = extractClaudeSessionId(body, options?.claudeSessionId);
  let providerOptions = deepMergeProviderOptions(
    thinkingProviderOptions(npm, options?.reasoningMetadata),
    effortProviderOptions(npm, effort, options?.reasoningMetadata?.upstreamModelId ?? body.model, options?.reasoningMetadata),
  );

  if (options?.openAiOAuth && systemText) {
    const instructions = compactRequest
      ? `${systemText}\n\n${COMPACT_OAUTH_INSTRUCTION}`
      : systemText;
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: { instructions },
    });
  }

  const { explicit: supportsExplicitOpenAiCaching, key: promptCacheKey } =
    openAiCacheSettings(npm, body, options, claudeSessionId, baseSystem, upstreamTools);
  const { enabled: anthropicCache, markedSystem: markedAnthropicSystem, cacheOptions } = anthropicCacheSettings(npm, body);
  if (cacheOptions) providerOptions = deepMergeProviderOptions(providerOptions, cacheOptions);
  if (promptCacheKey) {
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: {
        promptCacheKey,
        ...(supportsExplicitOpenAiCaching
          ? { promptCacheOptions: { mode: 'implicit', ttl: '30m' } }
          : {}),
      },
    });
  }

  return {
    instructions: options?.openAiOAuth || (supportsExplicitOpenAiCaching && !anthropicCache) || markedAnthropicSystem ? undefined : systemText,
    messages: [
      ...(markedAnthropicSystem ? anthropicSystemMessages(body.system) : []),
      ...(supportsExplicitOpenAiCaching && !anthropicCache ? translateTopLevelSystemForOpenAi(body.system) : []),
      ...translateMessages(messages, npm, supportsExplicitOpenAiCaching),
    ],
    allowSystemInMessages: true,
    tools: translateTools(upstreamTools.length ? upstreamTools : undefined, anthropicCache),
    toolChoice: compactRequest ? 'none' : translateToolChoice(body.tool_choice),
    maxOutputTokens: options?.openAiOAuth ? undefined : body.max_tokens,
    temperature: options?.reasoningMetadata?.supportsTemperature === false
      ? undefined
      : body.temperature,
    maxRetries: ['antigravity', 'opencode-zen'].includes(options?.reasoningMetadata?.providerId ?? '') ? 0 : options?.openAiOAuth
      ? OPENAI_OAUTH_SDK_MAX_RETRIES
      : SDK_MAX_RETRIES_NON_OAUTH,
    headers: sessionHeaders(options, promptCacheKey, claudeSessionId),
    providerOptions,
    inputTokensIncludeCache: CACHE_INCLUSIVE_INPUT_NPMS.has(npm),
  };
}

export type { FullStreamPart };
