// Anthropic /v1/messages request → Vercel AI SDK ModelMessage[] translation.
import { createHash } from 'node:crypto';
import { tool, jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import {
  splitToolUseId,
  serializeToolResultContent,
  type FullStreamPart,
} from './proxy-shared.js';
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

export { ToolResultImageError };

// ── Anthropic request shapes (only the fields we read) ───────────────────────
interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  source?: { type: 'base64' | 'url'; media_type?: string; data?: string; url?: string };
  cache_control?: { type?: string; ttl?: string };
  // internal: resolved tool name for a tool_result, set by annotateToolNames
  _name?: string;
}
interface AnthropicMsg { role: 'user' | 'assistant' | 'system'; content: string | AnthropicBlock[]; }
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type?: string; ttl?: string };
}
export interface AnthropicRequest {
  model: string;
  system?: string | Array<string | { text?: string; cache_control?: { type?: string; ttl?: string } }>;
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
}

export interface TranslateRequestOptions {
  /** Fallback when the client omits effort (e.g. Claude Desktop gateway). */
  defaultEffort?: string;
  reasoningMetadata?: ReasoningMetadata;
  /** ChatGPT Codex OAuth requires instructions and manages its own output limit. */
  openAiOAuth?: boolean;
  /** Fallback session identity from X-Claude-Code-Session-Id. Body metadata wins. */
  claudeSessionId?: string;
  /** Hard cap on tools sent to the provider (e.g. Groq: 128). Excess tools are silently dropped. */
  maxTools?: number;
}

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validClaudeSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CLAUDE_SESSION_ID_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}
/** Extract Claude Code's stable session UUID without accepting arbitrary metadata. */
export function extractClaudeSessionId(
  body: Pick<AnthropicRequest, 'metadata'>,
  headerFallback?: string,
): string | undefined {
  const userId = body.metadata?.user_id;
  if (typeof userId === 'string') {
    try {
      const parsed = JSON.parse(userId) as { session_id?: unknown };
      const fromMetadata = validClaudeSessionId(parsed?.session_id);
      if (fromMetadata) return fromMetadata;
    } catch {
      // Malformed or non-JSON metadata is ignored. the header remains usable.
    }
  }
  return validClaudeSessionId(headerFallback);
}
/** Opaque prompt-cache partition derived from a Claude session UUID. */
export function claudeSessionPromptCacheKey(sessionId: string): string {
  return 'relay-session-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}
/** Read reasoning effort from an Anthropic-format request body. */
export function anthropicEffortFromRequest(body: AnthropicRequest): string | undefined {
  const effort = body.output_config?.effort;
  if (typeof effort === 'string' && effort.trim()) return effort.trim();
  return undefined;
}
/**
 * Stable OpenAI `prompt_cache_key` derived from the request's cacheable prefix
 * (top-level system prompt + tool definitions). OpenAI caches prompt prefixes
 * automatically; this key routes requests that share that prefix to the same
 * cache partition, raising hit rate (important in server mode where many
 * concurrent Claude Code sessions share one relay process).
 *
 * Keyed only on the STABLE prefix: within one Claude Code session every turn
 * sends byte-identical system+tools → same key → warm routing, while distinct
 * sessions (a different date/cwd baked into the system prompt) get distinct
 * keys, which is correct since they share no cacheable prefix. Deliberately
 * excludes folded inline system-reminders, since those carry per-request-volatile
 * content (fresh timestamps, injected context) that would churn the key every
 * turn and defeat grouping.
 */
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
/** Public OpenAI models that implement explicit prompt-cache breakpoints. */
export function supportsOpenAiPromptCacheBreakpoints(modelId: string): boolean {
  const match = modelId.toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
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
  providerOptions?: Record<string, Record<string, unknown>>;
  inputTokensIncludeCache?: boolean;
}
// ── system ───────────────────────────────────────────────────────────────────
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

function openAiCacheBreakpoint(block: AnthropicBlock, enabled: boolean): Record<string, unknown> | undefined {
  if (!enabled || !block.cache_control) return undefined;
  return { openai: { promptCacheBreakpoint: { mode: 'explicit' } } };
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
// ── images ───────────────────────────────────────────────────────────────────
const SUPPORTED_TOOL_RESULT_IMAGE_MEDIA_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function strictBase64Data(data: string): Uint8Array {
  if (
    !data
    || data.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new ToolResultImageError('malformed_base64');
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.toString('base64') !== data) {
    throw new ToolResultImageError('malformed_base64');
  }
  return decoded;
}

function toolResultImagePart(block: AnthropicBlock): SdkImagePart {
  const source = block.source;
  if (!source) throw new ToolResultImageError('missing_source');
  const mediaType = source.media_type?.toLowerCase();
  if (!mediaType || !SUPPORTED_TOOL_RESULT_IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new ToolResultImageError('unsupported_media_type');
  }
  if (source.type === 'base64') {
    if (typeof source.data !== 'string') throw new ToolResultImageError('malformed_base64');
    return {
      type: 'file',
      data: { type: 'data', data: strictBase64Data(source.data) },
      mediaType,
    };
  }
  if (source.type === 'url') {
    if (typeof source.url !== 'string') throw new ToolResultImageError('invalid_url');
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new ToolResultImageError('invalid_url');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ToolResultImageError('invalid_url');
    }
    return { type: 'file', data: { type: 'url', url }, mediaType };
  }
  throw new ToolResultImageError('missing_source');
}

type SdkImagePart = Record<string, unknown> & {
  type: 'file';
  data: { type: 'data'; data: Uint8Array } | { type: 'url'; url: URL };
  mediaType: string;
};

function imagePart(block: AnthropicBlock): SdkImagePart | null {
  const src = block.source;
  if (!src) return null;
  if (src.type === 'base64' && src.data) {
    return {
      type: 'file',
      data: { type: 'data', data: Buffer.from(src.data, 'base64') },
      mediaType: src.media_type ?? 'image',
    };
  }
  if (src.type === 'url' && src.url) {
    return {
      type: 'file',
      data: { type: 'url', url: new URL(src.url) },
      mediaType: src.media_type ?? 'image',
    };
  }
  return null;
}
/**
 * Serialize a tool_result for the text-only function-output channel, lifting
 * image blocks out into user-message parts (the caller pushes them right after
 * the tool message). Left inline, an image's base64 payload would be
 * JSON.stringify'd into the output text and tokenized as text at ~1.5 chars
 * per token, so a single screenshot can cost 200k+ tokens upstream.
 */
function serializeToolResultForModel(
  tr: AnthropicBlock,
  imageParts: Array<Record<string, unknown>>,
): string {
  if (!Array.isArray(tr.content)) return serializeToolResultContent(tr.content);
  const rawId = splitToolUseId(tr.tool_use_id ?? '').rawId;
  let imageIndex = 0;
  const blocks = (tr.content as AnthropicBlock[]).map(block => {
    if (!block || block.type !== 'image') return block;
    const part = toolResultImagePart(block);
    imageIndex += 1;
    const label = `image ${imageIndex} of tool call ${rawId}`;
    imageParts.push({ type: 'text', text: `The following image is ${label}:` }, part);
    return { type: 'image', note: `attached to the next user message as ${label}` };
  });
  return JSON.stringify(blocks);
}
// ── tool_result name resolution (tool messages need the tool name) ────────────
export function annotateToolNames(messages: AnthropicMsg[]): void {
  const nameById = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.id && b.name) nameById.set(splitToolUseId(b.id).rawId, b.name);
    }
  }
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        b._name = nameById.get(splitToolUseId(b.tool_use_id).rawId);
      }
    }
  }
}

function thinkingToSdkPart(
  block: AnthropicBlock,
  npm: string,
): Record<string, unknown> | null {
  const text = block.thinking ?? '';
  if (npm === '@ai-sdk/openai' && !block.signature && !text.trim()) return null;

  const part: Record<string, unknown> = { type: 'reasoning', text };
  if (block.signature) {
    if (npm === '@ai-sdk/google') {
      part.providerOptions = { google: { thoughtSignature: block.signature } };
    } else if (npm === '@ai-sdk/openai' || npm === '@ai-sdk/openai-compatible') {
      part.providerOptions = { openai: { reasoningEncryptedContent: block.signature } };
    }
  }
  return part;
}
// ── messages: Anthropic → SDK ModelMessage[] ─────────────────────────────────
export function translateMessages(
  messages: AnthropicMsg[],
  npm: string,
  openAiPromptCacheBreakpoints = false,
): ModelMessage[] {
  const isGoogle = npm === '@ai-sdk/google';
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    const blocks: AnthropicBlock[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content ?? [];

    if (msg.role === 'system') {
      // Claude Code deliberately injects trusted system messages within the
      // conversation. Preserve their position instead of moving volatile
      // reminders ahead of the stable history and invalidating the whole cache.
      for (const block of blocks) {
        if (block.type !== 'text' || !block.text?.trim()) continue;
        out.push({
          role: 'system',
          content: block.text,
          ...(openAiCacheBreakpoint(block, openAiPromptCacheBreakpoints)
            ? { providerOptions: openAiCacheBreakpoint(block, openAiPromptCacheBreakpoints) }
            : {}),
        } as unknown as ModelMessage);
      }
    } else if (msg.role === 'user') {
      const toolResults = blocks.filter(b => b.type === 'tool_result');
      const parts: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push({
            type: 'text',
            text: b.text ?? '',
            ...(openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints)
              ? { providerOptions: openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints) }
              : {}),
          });
        } else if (b.type === 'image') {
          const p = imagePart(b);
          if (p) {
            parts.push({
              ...p,
              ...(openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints)
                ? { providerOptions: openAiCacheBreakpoint(b, openAiPromptCacheBreakpoints) }
                : {}),
            });
          }
        }
      }
      const toolResultImageParts: Array<Record<string, unknown>> = [];
      if (toolResults.length) {
        out.push({
          role: 'tool',
          content: toolResults.map(tr => ({
            type: 'tool-result',
            toolCallId: splitToolUseId(tr.tool_use_id ?? '').rawId,
            toolName: tr._name ?? 'unknown',
            output: { type: 'text', value: serializeToolResultForModel(tr, toolResultImageParts) },
            ...(openAiCacheBreakpoint(tr, openAiPromptCacheBreakpoints)
              ? { providerOptions: openAiCacheBreakpoint(tr, openAiPromptCacheBreakpoints) }
              : {}),
          })),
        } as unknown as ModelMessage);
      }
      const userParts = [...toolResultImageParts, ...parts];
      if (userParts.length) out.push({ role: 'user', content: userParts } as unknown as ModelMessage);
    } else if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text ?? '' });
        } else if (b.type === 'thinking') {
          const part = thinkingToSdkPart(b, npm);
          if (part) parts.push(part);
        } else if (b.type === 'tool_use' && b.id) {
          const { rawId, thoughtSignature } = splitToolUseId(b.id);
          const part: Record<string, unknown> = {
            type: 'tool-call', toolCallId: rawId, toolName: b.name, input: b.input ?? {},
          };
          if (thoughtSignature && isGoogle) part.providerOptions = { google: { thoughtSignature } };
          parts.push(part);
        }
      }
      if (parts.length) out.push({ role: 'assistant', content: parts } as unknown as ModelMessage);
    }
  }
  return out;
}
/**
 * Strip filler values GPT-family models emit for optional params instead of
 * omitting them: top-level `null` always, and empty arrays for properties the
 * tool's schema does not require. Claude Code forwards some tool inputs
 * verbatim into server-side API calls (e.g. WebSearch domain lists become the
 * `web_search` tool config, where an empty list is a 400), so filler must be
 * removed here. Required properties keep their empty arrays: there an empty
 * array is an intentional value (e.g. TodoWrite's `todos: []` clears the list).
 */
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
/** Per-tool sanitization rules, read back out of the translated tool schemas. */
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

export function translateTools(anthropicTools?: AnthropicTool[]): Record<string, ReturnType<typeof tool>> | undefined {
  if (!anthropicTools?.length) return undefined;
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const t of anthropicTools) {
    if (!t.name || !t.input_schema) continue;
    tools[t.name] = tool({ description: t.description ?? '', inputSchema: jsonSchema(t.input_schema) });
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
/**
 * Claude Code's structured-output agents inherit the terminal StructuredOutput
 * tool when they fork a reactive compaction turn, even though the compact prompt
 * requires plain text and rejects every tool call. OpenAI-family models tend to
 * call that highly salient tool, leaving Claude Code with an empty summary.
 *
 * Detect only the observed compact envelope. If Claude Code changes it, this
 * deliberately fails open rather than stripping tools from an ordinary request.
 */
function isClaudeCodeStructuredOutputCompactRequest(body: AnthropicRequest): boolean {
  if (body.diagnostics !== undefined) return false;
  if (!body.tools?.some(candidate => candidate.name === 'StructuredOutput')) return false;

  const finalMessage = body.messages.at(-1);
  if (!finalMessage || finalMessage.role !== 'user') return false;
  const text = typeof finalMessage.content === 'string'
    ? finalMessage.content
    : finalMessage.content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n');
  return text.includes(COMPACT_TEXT_ONLY_START) && text.includes(COMPACT_TEXT_ONLY_END);
}
/**
 * OAuth uses Relay's outer replay only; nested SDK retries would multiply attempts.
 * Non-OAuth keeps one inner retry for pre-stream transients with SDK backoff,
 * while proxy replay handles pre-output stream failures: at most six attempts,
 * rather than nine from combining both default retry budgets.
 */
const OPENAI_OAUTH_SDK_MAX_RETRIES = 0;
const SDK_MAX_RETRIES_NON_OAUTH = 1;
const CACHE_INCLUSIVE_INPUT_NPMS = new Set([
  '@ai-sdk/openai',
  '@ai-sdk/openai-compatible',
  '@ai-sdk/anthropic',
  VERTEX_ANTHROPIC_NPM,
]);

export function translateRequest(
  body: AnthropicRequest,
  npm: string,
  options?: TranslateRequestOptions,
): SdkCallParams {
  const messages = body.messages ?? [];
  annotateToolNames(messages);
  const baseSystem = systemToString(body.system, options?.openAiOAuth === true);
  const systemText = baseSystem?.trim() || (options?.openAiOAuth ? 'You are a coding assistant.' : undefined);
  // resolveUpstreamTools uses the shared proxy types. the adapter keeps its own
  // minimal request shapes, so cast at this boundary. Keep compact-request tool
  // definitions intact for prompt-cache prefix reuse. toolChoice='none' below
  // makes them unavailable at the provider API rather than by prompt compliance.
  const compactRequest = isClaudeCodeStructuredOutputCompactRequest(body);
  let upstreamTools = resolveUpstreamTools(
    body.tools as unknown as AnthropicToolDefinition[] | undefined,
    messages as unknown as AnthropicRequestMessage[],
  ) as unknown as AnthropicTool[];
  if (options?.maxTools !== undefined && upstreamTools.length > options.maxTools) {
    upstreamTools = upstreamTools.slice(0, options.maxTools);
  }
  const effort = anthropicEffortFromRequest(body) ?? options?.defaultEffort;
  let providerOptions = deepMergeProviderOptions(
    thinkingProviderOptions(npm),
    effortProviderOptions(npm, effort, options?.reasoningMetadata?.upstreamModelId ?? body.model, options?.reasoningMetadata),
  );
  // ChatGPT Codex OAuth backend requires `instructions` in providerOptions and
  // rejects the standard `system` field. It also manages its own output limit.
  if (options?.openAiOAuth && systemText) {
    const instructions = compactRequest
      ? `${systemText}\n\n${COMPACT_OAUTH_INSTRUCTION}`
      : systemText;
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: { instructions },
    });
  }

  const upstreamModelId = options?.reasoningMetadata?.upstreamModelId ?? body.model;
  const supportsExplicitOpenAiCaching = !options?.openAiOAuth
    && supportsOpenAiPromptCacheBreakpoints(upstreamModelId);
  if (npm === '@github/copilot-sdk') {
    const claudeSessionId = extractClaudeSessionId(body, options?.claudeSessionId);
    if (claudeSessionId !== undefined) {
      providerOptions = deepMergeProviderOptions(providerOptions, {
        copilot: {
          claudeSessionId,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        },
      });
    }
  }

  if (npm === '@ai-sdk/openai') {
    const claudeSessionId = extractClaudeSessionId(body, options?.claudeSessionId);
    providerOptions = deepMergeProviderOptions(providerOptions, {
      openai: {
        promptCacheKey: claudeSessionId
          ? claudeSessionPromptCacheKey(claudeSessionId)
          : openAiPromptCacheKey(baseSystem, upstreamTools),
        ...(supportsExplicitOpenAiCaching
          ? { promptCacheOptions: { mode: 'implicit', ttl: '30m' } }
          : {}),
      },
    });
  }

  return {
    instructions: options?.openAiOAuth || supportsExplicitOpenAiCaching ? undefined : systemText,
    messages: [
      ...(supportsExplicitOpenAiCaching ? translateTopLevelSystemForOpenAi(body.system) : []),
      ...translateMessages(messages, npm, supportsExplicitOpenAiCaching),
    ],
    allowSystemInMessages: true,
    tools: translateTools(upstreamTools.length ? upstreamTools : undefined),
    toolChoice: compactRequest ? 'none' : translateToolChoice(body.tool_choice),
    maxOutputTokens: options?.openAiOAuth ? undefined : body.max_tokens,
    temperature: body.temperature,
    maxRetries: options?.openAiOAuth
      ? OPENAI_OAUTH_SDK_MAX_RETRIES
      : SDK_MAX_RETRIES_NON_OAUTH,
    providerOptions,
    inputTokensIncludeCache: CACHE_INCLUSIVE_INPUT_NPMS.has(npm),
  };
}

export type { FullStreamPart };
