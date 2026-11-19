import { wrapLanguageModel } from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { OPENAI_CHATGPT_PLAN_BASE_URL } from './constants.js';

const RESPONSES_URL = `${OPENAI_CHATGPT_PLAN_BASE_URL}/responses`;
const TOOL_NAMESPACE = 'claude_code';
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
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
  if (typeof model !== 'string' || !/^gpt-6\.2(?:-|$)/.test(model) || typeof instructions !== 'string' || !instructions.trim()) {
    return input;
  }
  delete body.instructions;
  return [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: instructions }] }, ...input];
}

export function createChatGptPlanFetch(accessToken: string, fetchImpl?: typeof fetch): typeof fetch {
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

export function requireChatGptPlanTerminalEvent(model: LanguageModelV4): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        let terminal = false;
        return { ...result, stream: result.stream.pipeThrough(new TransformStream({
          transform(part, controller) {
            if (part.type === 'raw') {
              const event = part.rawValue as { type?: string } | null;
              if (event?.type && TERMINAL_EVENTS.has(event.type)) terminal = true;
              return;
            }
            if (part.type === 'finish' && !terminal) {
              controller.error(new Error('ChatGPT plan stream ended before OpenAI sent a terminal event.'));
              return;
            }
            controller.enqueue(part);
          },
        })) };
      },
    },
  });
}
