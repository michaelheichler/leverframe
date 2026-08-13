/**
 * Renders a complete V3 prompt for a newly created Copilot session after resync.
 * Canonical JSON keeps transcript data separate from the synchronization instruction.
 */

import type {
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from '@ai-sdk/provider';
import { canonicalJson } from './canonical-json.js';

interface RenderedPart {
  type: string;
  text?: string;
  reference?: string;
  mediaType?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  status?: 'ok' | 'error';
  output?: unknown;
}

function renderOutput(output: LanguageModelV3ToolResultOutput): {
  status: 'ok' | 'error';
  output: unknown;
} {
  if (output.type === 'text' || output.type === 'json') {
    return { status: 'ok', output: output.value };
  }
  if (output.type === 'error-text' || output.type === 'error-json') {
    return { status: 'error', output: output.value };
  }
  if (output.type === 'execution-denied') {
    return { status: 'error', output: output.reason ?? 'execution denied' };
  }
  if (output.type === 'content') return { status: 'ok', output: output.value };
  throw new TypeError('Unsupported V3 tool-result output');
}

function remoteImage(data: unknown, mediaType: string): RenderedPart {
  if (!(data instanceof URL) || !['http:', 'https:'].includes(data.protocol)) {
    throw new TypeError(`Copilot history does not support embedded ${mediaType} files`);
  }
  if (data.username || data.password || data.search || data.hash) {
    throw new TypeError('Copilot history does not support secret-bearing image URLs');
  }
  if (!mediaType.startsWith('image')) {
    throw new TypeError(`Copilot history does not support ${mediaType} files`);
  }
  return { type: 'image', reference: data.href, mediaType };
}

function renderPart(value: unknown): RenderedPart {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('Copilot history prompt part must be an object');
  }
  const part = value as Record<string, unknown>;
  if (part.type === 'text' || part.type === 'reasoning') {
    if (typeof part.text !== 'string') throw new TypeError(`${part.type} text must be a string`);
    return { type: part.type, text: part.text };
  }
  if (part.type === 'file') {
    if (typeof part.mediaType !== 'string') throw new TypeError('File mediaType must be a string');
    return remoteImage(part.data, part.mediaType);
  }
  if (part.type === 'tool-call') {
    if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') {
      throw new TypeError('Tool-call identity must be a string');
    }
    return {
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      input: part.input,
    };
  }
  if (part.type === 'tool-result') {
    if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') {
      throw new TypeError('Tool-result identity must be a string');
    }
    const rendered = renderOutput(part.output as LanguageModelV3ToolResultOutput);
    return {
      type: 'tool-result',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      status: rendered.status,
      output: rendered.output,
    };
  }
  throw new TypeError(`Copilot history does not support ${String(part.type)} prompt parts`);
}

function renderMessage(message: LanguageModelV3Message): Record<string, unknown> {
  return message.role === 'system'
    ? { role: message.role, content: message.content }
    : { role: message.role, content: message.content.map(renderPart) };
}

/** Renders every prompt message with an explicit format version. */
export function renderCopilotHistory(prompt: LanguageModelV3Prompt, version: number): string {
  const transcript = canonicalJson({
    format: `leverframe-copilot-history-v${version}`,
    messages: prompt.map(renderMessage),
  });
  return [
    'Continue from the final turn in this prior conversation transcript.',
    transcript,
  ].join('\n');
}
