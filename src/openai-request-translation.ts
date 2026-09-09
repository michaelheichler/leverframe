import { tool, jsonSchema, type ModelMessage, type UserContent } from 'ai';
import { parseToolArguments } from './proxy-shared.js';
import type { SdkCallParams } from './sdk-adapter.js';

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

function translateImageContent(image: Record<string, unknown>): Exclude<UserContent, string>[number] {
  if (typeof image.url !== 'string') throw new Error('Invalid OpenAI image URL');
  const detail = image.detail;
  if (detail !== undefined && detail !== 'auto' && detail !== 'low' && detail !== 'high') {
    throw new Error('Invalid OpenAI image detail');
  }
  return {
    type: 'file', mediaType: 'image/*', data: new URL(image.url),
    ...(detail ? { providerOptions: { openai: { imageDetail: detail } } } : {}),
  };
}

function translateUserPart(part: unknown): Exclude<UserContent, string>[number] {
  if (typeof part !== 'object' || part === null) throw new Error('Invalid OpenAI content part');
  const value = part as Record<string, unknown>;
  if (value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text };
  if (value.type === 'image_url' && typeof value.image_url === 'object' && value.image_url !== null) {
    return translateImageContent(value.image_url as Record<string, unknown>);
  }
  throw new Error(`Unsupported OpenAI content part: ${String(value.type)}`);
}

function translateUserContent(content: OpenAiMessage['content']): UserContent {
  return Array.isArray(content) ? content.map(translateUserPart) : content ?? '';
}

function translateAssistantMessage(msg: OpenAiMessage): ModelMessage {
  const parts: unknown[] = [];
  if (typeof msg.content === 'string' && msg.content) {
    parts.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls ?? []) {
    parts.push({
      type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name,
      input: parseToolArguments(tc.function.arguments),
    });
  }
  return { role: 'assistant', content: parts.length > 0 ? parts : '' } as unknown as ModelMessage;
}

function appendToolResult(messages: ModelMessage[], msg: OpenAiMessage, toolNameById: Map<string, string>): void {
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
}

export function translateOpenAiRequest(
  body: OpenAiRequest,
  options?: {

    openAiOAuth?: boolean;
  },
): SdkCallParams {

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
    if (msg.role === 'system' && collectingLeadingSystem) {
      if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
      continue;
    }
    collectingLeadingSystem = false;
    switch (msg.role) {
      case 'system':
        messages.push({ role: 'system', content: msg.content } as unknown as ModelMessage);
        break;

      case 'user':
        messages.push({ role: 'user', content: translateUserContent(msg.content) });
        break;

      case 'assistant':
        messages.push(translateAssistantMessage(msg));
        break;

      case 'tool':
        appendToolResult(messages, msg, toolNameById);
        break;
    }
  }

  let sdkToolChoice: SdkCallParams['toolChoice'];
  if (body.tool_choice === 'auto' || body.tool_choice === 'required' || body.tool_choice === 'none') {
    sdkToolChoice = body.tool_choice;
  } else if (typeof body.tool_choice === 'object' && body.tool_choice?.type === 'function') {
    sdkToolChoice = { type: 'tool', toolName: body.tool_choice.function.name };
  }

  let tools: SdkCallParams['tools'];
  if (body.tools?.length) {
    const toolMap: Record<string, ReturnType<typeof tool>> = {};
    for (const t of body.tools) {
      if (t.type !== 'function' || !t.function.name) continue;
      const schema = t.function.parameters ? jsonSchema(t.function.parameters) : undefined;
      toolMap[t.function.name] = tool({
        description: t.function.description ?? '',
        inputSchema: (schema ?? jsonSchema({ type: 'object', properties: {} })) as Parameters<typeof tool>[0]['inputSchema'],
      });
    }
    tools = toolMap as unknown as SdkCallParams['tools'];
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  if (options?.openAiOAuth) {

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
