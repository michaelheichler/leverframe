import { wrapLanguageModel } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { OPENAI_CHATGPT_PLAN_BASE_URL } from './constants.js';
import type { ChatGptPlanCacheDiagnostics, ChatGptPlanCompletedResponse } from './openai-chatgpt-plan-cache-diagnostics.js';
import { createAppendOnlyTools } from './openai-chatgpt-plan-append-only-tools.js';

const RESPONSES_URL = `${OPENAI_CHATGPT_PLAN_BASE_URL}/responses`;
const TOOL_NAMESPACE = 'claude_code';
const CACHEABLE_INSTRUCTIONS_MODEL = /^gpt-6\.2(?:-|$)/;
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const MISSING_TERMINAL_EVENT = 'ChatGPT plan stream ended before OpenAI sent a terminal event.';
const OMITTED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier',
  'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
  'context_management', 'service_tier',
];

function normalizeTools(body: Record<string, unknown>): void {
  if (!Array.isArray(body.tools)) return;
  const localTools = [];
  const hostedTools = [];
  for (const tool of body.tools) {
    if (tool?.type === 'function') {
      localTools.push({ ...tool, strict: false });
    } else if (tool?.type === 'custom') {
      localTools.push(tool);
    } else if (tool?.type === 'web_search' || tool?.type === 'web_search_preview') {
      hostedTools.push(tool);
    } else {
      throw new TypeError('ChatGPT plan requests support local function tools and web search.');
    }
  }
  if (typeof body.model === 'string' && CACHEABLE_INSTRUCTIONS_MODEL.test(body.model)) {
    localTools.sort((left, right) => left.name < right.name ? -1 : Number(left.name > right.name));
  }
  body.tools = localTools.length > 0
    ? [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Local Claude Code tools', tools: localTools }, ...hostedTools]
    : hostedTools;
}

function normalizeInput(input: unknown): unknown[] {
  if (!Array.isArray(input)) throw new TypeError('ChatGPT plan requests require an input array.');
  return input.map(item => {
    if (item?.role === 'system') return { ...item, role: 'developer' };
    if (item?.type === 'function_call' || item?.type === 'custom_tool_call') return { ...item, namespace: TOOL_NAMESPACE };
    return item;
  });
}

function cacheableInput(body: Record<string, unknown>): unknown[] {
  const input = normalizeInput(body.input);
  const { model, instructions } = body;
  if (typeof model !== 'string' || !CACHEABLE_INSTRUCTIONS_MODEL.test(model) || typeof instructions !== 'string' || !instructions.trim()) {
    return input;
  }
  delete body.instructions;
  return [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }, ...input];
}

export function createChatGptPlanFetch(
  accessToken: string,
  fetchImpl?: typeof fetch,
  diagnostics?: ChatGptPlanCacheDiagnostics,
): typeof fetch {
  const appendOnlyTools = process.env['LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS'] === '1' ? createAppendOnlyTools() : undefined;
  return (input, init) => {
    if (String(input) !== RESPONSES_URL || init?.method !== 'POST' || typeof init.body !== 'string') {
      throw new TypeError('ChatGPT plan credentials require the OpenAI Responses endpoint.');
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (body.stream !== true) throw new TypeError('ChatGPT plan requests require streaming inference.');
    for (const field of OMITTED_FIELDS) delete body[field];
    body.store = false;
    body.input = cacheableInput(body);
    normalizeTools(body);
    const toolDeclarationPolicy = typeof body.model === 'string' && CACHEABLE_INSTRUCTIONS_MODEL.test(body.model)
      ? appendOnlyTools : undefined;
    toolDeclarationPolicy?.(body, TOOL_NAMESPACE);
    const comparisonResponseId = diagnostics?.prepare(body, Boolean(toolDeclarationPolicy));
    if (comparisonResponseId) {
      body.prompt_cache_options = {
        ...body.prompt_cache_options as Record<string, unknown> | undefined,
        comparison_response_id: comparisonResponseId,
      };
    }
    return (fetchImpl ?? globalThis.fetch)(RESPONSES_URL, {
      ...init,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  };
}

export function requireChatGptPlanTerminalEvent(model: LanguageModelV4, diagnostics?: ChatGptPlanCacheDiagnostics): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
      wrapStream: async ({ doStream }) => {
        const tracked = diagnostics ? await diagnostics.withRequest(doStream) : undefined;
        const result = tracked ? tracked.result : await doStream();
        const upstreamRequestId = result.response?.headers?.['x-request-id'];
        let terminal = false;
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            if (part.type === 'raw') {
              const event = part.rawValue as { type?: string; response?: ChatGptPlanCompletedResponse } | null;
              if (event?.type && TERMINAL_EVENTS.has(event.type)) terminal = true;
              if (event?.type === 'response.completed') {
                diagnostics?.record(event.response ?? {}, tracked?.request, upstreamRequestId);
              } else if (event?.type === 'response.incomplete') {
                diagnostics?.record(event.response ?? {}, tracked?.request, upstreamRequestId, 'incomplete');
              } else if (event?.type === 'response.failed' || event?.type === 'error') {
                diagnostics?.record(event.response ?? {}, tracked?.request, upstreamRequestId, 'failed');
              }
              return;
            }
            if (part.type === 'finish' && !terminal) {
              diagnostics?.record({}, tracked?.request, upstreamRequestId, 'incomplete');
              controller.error(new Error(MISSING_TERMINAL_EVENT));
              return;
            }
            if (part.type === 'finish' && part.usage.raw) {
              const raw = part.usage.raw as { input_tokens_details?: { cached_tokens?: number | null } | null };
              if (raw.input_tokens_details?.cached_tokens == null) {
                const { usage } = part;
                const total = usage.inputTokens.total;
                controller.enqueue({
                  ...part,
                  usage: { ...usage, inputTokens: { ...usage.inputTokens, noCache: undefined, cacheRead: undefined } },
                  ...(total === undefined ? {} : {
                    providerMetadata: {
                      ...part.providerMetadata,
                      leverframeCacheUsage: { ...part.providerMetadata?.leverframeCacheUsage, totalInputTokens: total },
                    },
                  }),
                });
                return;
              }
            }
            controller.enqueue(part);
          },
          flush(controller) {
            if (terminal) return;
            diagnostics?.record({}, tracked?.request, upstreamRequestId, 'incomplete');
            controller.error(new Error(MISSING_TERMINAL_EVENT));
          },
        })) };
      },
    },
  });
}
