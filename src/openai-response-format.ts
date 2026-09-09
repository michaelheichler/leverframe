import type { CollectedOpenAiStream } from './openai-adapter.js';

export function openAiFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'content-filter': return 'content_filter';
    case 'length': return 'length';
    default: return 'stop';
  }
}

export function formatOpenAiResponse(
  result: { text: string; toolCalls?: CollectedOpenAiStream['toolCalls']; finishReason?: string; usage?: CollectedOpenAiStream['usage'] },
  responseModelId: string,
) {
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
    choices: [{ index: 0, message, finish_reason: openAiFinishReason(result.finishReason) }],
    usage: {
      prompt_tokens: result.usage?.inputTokens ?? 0,
      completion_tokens: result.usage?.outputTokens ?? 0,
      total_tokens: result.usage?.totalTokens ?? 0,
    },
  };
}
