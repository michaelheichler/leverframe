import { tool, jsonSchema, streamText, generateText } from 'ai';
import type { LanguageModel, ModelMessage } from 'ai';
import { parseToolArguments } from './proxy-shared.js';
import type { SdkCallParams } from './sdk-adapter.js';
import type { RequestExecutionObserver } from './request-execution-context.js';
import { toUpstreamStreamError } from './stream-error.js';

// ── OpenAI request shapes ───────────────────────────────────────────────────

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null | Array<unknown>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface OpenAiRequest {
  model: string;
  messages: OpenAiMessage[];
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters?: Record<string, unknown> };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
}

// ── Translation: OpenAI Request → SDK Call Params ───────────────────────────

export function translateOpenAiRequest(
  body: OpenAiRequest,
  options?: {
    /** ChatGPT Codex OAuth requires instructions in providerOptions and manages its own output limit. */
    openAiOAuth?: boolean;
  },
): SdkCallParams {
  // Pre-scan to map tool_call_id → function name so tool result messages can reference it.
  const toolNameById = new Map<string, string>();
  for (const msg of body.messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }

  const systemParts: string[] = [];
  const messages: ModelMessage[] = [];
  let collectingLeadingSystem = true;

  for (const msg of body.messages) {
    if (msg.role !== 'system') collectingLeadingSystem = false;
    switch (msg.role) {
      case 'system':
        if (collectingLeadingSystem) {
          if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
        } else {
          messages.push({ role: 'system', content: msg.content } as unknown as ModelMessage);
        }
        break;

      case 'user':
        messages.push({ role: 'user', content: msg.content } as unknown as ModelMessage);
        break;

      case 'assistant': {
        const parts: unknown[] = [];
        if (typeof msg.content === 'string' && msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls ?? []) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input: parseToolArguments(tc.function.arguments),
          });
        }
        messages.push({ role: 'assistant', content: parts.length > 0 ? parts : '' } as unknown as ModelMessage);
        break;
      }

      case 'tool': {
        const resultPart = {
          type: 'tool-result',
          toolCallId: msg.tool_call_id ?? '',
          toolName: toolNameById.get(msg.tool_call_id ?? '') ?? 'unknown',
          output: {
            type: 'text',
            value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
          },
        };
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'tool' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as unknown[]).push(resultPart);
        } else {
          messages.push({ role: 'tool', content: [resultPart] } as unknown as ModelMessage);
        }
        break;
      }
    }
  }

  let sdkToolChoice: SdkCallParams['toolChoice'];
  if (body.tool_choice === 'auto' || body.tool_choice === 'required') {
    sdkToolChoice = body.tool_choice;
  } else if (typeof body.tool_choice === 'object' && body.tool_choice?.type === 'function') {
    sdkToolChoice = { type: 'tool', toolName: body.tool_choice.function.name };
  }

  let tools: SdkCallParams['tools'];
  if (body.tools?.length) {
    const toolMap: Record<string, ReturnType<typeof tool>> = {};
    for (const t of body.tools) {
      if (t.type === 'function' && t.function.name) {
        const schema = t.function.parameters ? jsonSchema(t.function.parameters) : undefined;
        toolMap[t.function.name] = tool({
          description: t.function.description ?? '',
          inputSchema: (schema ?? jsonSchema({ type: 'object', properties: {} })) as Parameters<typeof tool>[0]['inputSchema'],
        });
      }
    }
    tools = toolMap as unknown as SdkCallParams['tools'];
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  if (options?.openAiOAuth) {
    // Mirror the OAuth shaping in sdk-adapter's translateRequest: the ChatGPT
    // Codex OAuth backend rejects the standard system/instructions field (it
    // requires providerOptions.openai.instructions), manages its own output
    // limit (an explicit max_output_tokens yields an empty finish:'other'
    // response), and expects store:false.
    const instructions = system?.trim() || 'You are a coding assistant.';
    return {
      messages,
      tools,
      toolChoice: sdkToolChoice,
      temperature: body.temperature,
      maxRetries: 0,
      providerOptions: {
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          instructions,
        },
      },
    };
  }

  return {
    instructions: system,
    messages,
    tools,
    toolChoice: sdkToolChoice,
    temperature: body.temperature,
    maxOutputTokens: body.max_completion_tokens ?? body.max_tokens,
  };
}

// ── Translation: SDK Response → OpenAI JSON / SSE ───────────────────────────

export interface CollectedOpenAiStream {
  text: string;
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
  finishReason: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
}

/** Shape of one AI SDK `fullStream`/`textStream` part, as read dynamically by both adapters below. */
interface SdkStreamPart {
  type: string;
  textDelta?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  finishReason?: string;
  totalUsage?: CollectedOpenAiStream['usage'];
  usage?: CollectedOpenAiStream['usage'];
  error?: unknown;
  id?: string;
  delta?: string;
  argsTextDelta?: string;
}

/** Reduce an SDK full stream into the fields a non-streaming chat completion needs. */
export async function collectOpenAiStream(
  stream: AsyncIterable<unknown>,
  lifecycle?: RequestExecutionObserver,
): Promise<CollectedOpenAiStream> {
  const collected: CollectedOpenAiStream = { text: '', toolCalls: [], finishReason: undefined, usage: undefined };
  for await (const part of stream) {
    const p = part as SdkStreamPart;
    lifecycle?.markStreamActivity();
    switch (p.type) {
      case 'text-delta':
        collected.text += p.textDelta ?? p.text ?? '';
        if (collected.text) lifecycle?.markOutputEmitted();
        break;
      case 'tool-call':
        collected.toolCalls.push({
          toolCallId: p.toolCallId ?? '',
          toolName: p.toolName ?? '',
          input: p.input,
        });
        lifecycle?.markToolCallEmitted();
        break;
      case 'finish':
        collected.finishReason = p.finishReason ?? collected.finishReason;
        collected.usage = p.totalUsage ?? p.usage ?? collected.usage;
        break;
      case 'error':
        throw toUpstreamStreamError(p.error);
    }
  }
  return collected;
}

export interface OpenAiResponseOptions {
  forceStream?: boolean;
  abortSignal?: AbortSignal;
  onWarning?: (message: string) => void;
  /**
   * Request execution context/observer: driven for phase (connect/first
   * output/tool-call) transitions. Its `abortSignal` — already composed from
   * the caller's cancellation signal plus the connect/header/idle/total
   * deadline classes — takes priority over `abortSignal` above when present.
   * Terminal transitions (`complete`/`fail`) stay owned by the caller.
   */
  lifecycle?: RequestExecutionObserver;
}

export async function generateOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  options?: OpenAiResponseOptions,
) {
  const abortSignal = options?.lifecycle?.abortSignal ?? options?.abortSignal;
  options?.lifecycle?.startConnecting();
  let result: { text: string; toolCalls?: CollectedOpenAiStream['toolCalls']; finishReason?: string; usage?: CollectedOpenAiStream['usage'] };
  if (options?.forceStream) {
    // Some upstreams (e.g. ChatGPT's Codex OAuth backend) only ever answer as a
    // stream. Request a real stream from the SDK and collect it into one
    // response instead of issuing a non-streaming request upstream.
    const { stream } = streamText({
      model,
      ...params,
      abortSignal,
      onError: () => {},
    } as Parameters<typeof streamText>[0]);
    result = await collectOpenAiStream(stream, options?.lifecycle);
  } else {
    result = (await generateText({
      model,
      ...params,
      abortSignal,
    } as Parameters<typeof generateText>[0])) as typeof result;
  }
  options?.lifecycle?.markHeadersReceived();
  if (!result.usage || [result.usage.inputTokens, result.usage.outputTokens, result.usage.totalTokens].some(value => value === undefined)) {
    options?.onWarning?.(`warning: OpenAI adapter upstream omitted token usage for model ${responseModelId}; defaulting missing values to zero`);
  }
  if (result.text) options?.lifecycle?.markOutputEmitted();
  if (result.toolCalls?.length) options?.lifecycle?.markToolCallEmitted();
  const message: Record<string, unknown> = { role: 'assistant', content: result.text || null };

  if (result.toolCalls?.length) {
    message.tool_calls = result.toolCalls.map((tc: CollectedOpenAiStream['toolCalls'][number]) => ({
      id: tc.toolCallId,
      type: 'function',
      function: { name: tc.toolName, arguments: JSON.stringify(tc.input ?? {}) },
    }));
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
    choices: [{ index: 0, message, finish_reason: result.finishReason || 'stop' }],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: result.usage?.totalTokens ?? 0,
    },
  };
}

export async function streamOpenAiResponse(
  model: LanguageModel,
  params: SdkCallParams,
  responseModelId: string,
  onChunk: (chunk: string) => void,
  options?: { abortSignal?: AbortSignal; lifecycle?: RequestExecutionObserver },
): Promise<void> {
  const abortSignal = options?.lifecycle?.abortSignal ?? options?.abortSignal;
  options?.lifecycle?.startConnecting();
  const { stream } = streamText({
    model,
    ...params,
    abortSignal,
  } as Parameters<typeof streamText>[0]);
  const baseData = {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: responseModelId,
  };

  const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    onChunk(`data: ${JSON.stringify({ ...baseData, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const sendUsage = (usage: NonNullable<CollectedOpenAiStream['usage']>) => onChunk(`data: ${JSON.stringify({
    ...baseData,
    choices: [],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0,
    },
  })}\n\n`);

  let headersMarked = false;
  for await (const part of stream) {
    const p = part as SdkStreamPart;
    if (!headersMarked) {
      headersMarked = true;
      options?.lifecycle?.markHeadersReceived();
    }
    options?.lifecycle?.markStreamActivity();
    switch (p.type) {
      case 'text-delta':
        send({ role: 'assistant', content: p.textDelta ?? p.text ?? '' });
        options?.lifecycle?.markOutputEmitted();
        break;
      case 'tool-input-start':
        send({ role: 'assistant', tool_calls: [{ index: 0, id: p.id ?? p.toolCallId, type: 'function', function: { name: p.toolName, arguments: '' } }] });
        options?.lifecycle?.markToolCallEmitted();
        break;
      case 'tool-input-delta':
        send({ tool_calls: [{ index: 0, function: { arguments: p.delta ?? p.text ?? p.argsTextDelta ?? '' } }] });
        break;
      case 'finish': {
        send({}, p.finishReason || 'stop');
        const usage = p.totalUsage ?? p.usage;
        if (usage) sendUsage(usage);
        break;
      }
      case 'error':
        throw toUpstreamStreamError(p.error);
    }
  }

  onChunk('data: [DONE]\n\n');
}
