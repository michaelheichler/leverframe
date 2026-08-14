/**
 * Normalizes V3 prompts for session identity, continuation, and resynchronization.
 * Prompt content stays in memory and is rendered only when sent to the owned SDK session.
 */

import { createHash } from 'node:crypto';
import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3ToolResultPart,
} from '@ai-sdk/provider';
import { canonicalJson } from './canonical-json.js';
import { copilotImageReference } from './image-part.js';
import {
  type SerializedHistory,
  type SerializedHistoryPart,
  SERIALIZED_HISTORY_VERSION,
} from './serialized-history.js';
import {
  hashSystemPrompt,
  hashToolSchema,
  type TranscriptComparisonState,
} from './transcript.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function outputHash(output: LanguageModelV3ToolResultOutput): string {
  return sha256(canonicalJson(output));
}

function serializedPart(part: Record<string, unknown>): SerializedHistoryPart {
  if (part.type === 'text' || part.type === 'reasoning') {
    if (typeof part.text !== 'string') throw new TypeError(`${part.type} text must be a string`);
    return { type: part.type, text: part.text };
  }
  if (part.type === 'file') {
    const mediaType = part.mediaType;
    if (typeof mediaType !== 'string') throw new TypeError('Copilot supports only image prompt files');
    const image = copilotImageReference(part.data, mediaType);
    return { type: 'image', reference: image.reference, mediaType: image.mediaType };
  }
  if (part.type === 'tool-call') {
    if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string') {
      throw new TypeError('Copilot tool-call identifiers must be strings');
    }
    return {
      type: 'tool-call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      payloadHash: sha256(canonicalJson(part.input)),
    };
  }
  if (part.type === 'tool-result') {
    const result = part as unknown as LanguageModelV3ToolResultPart;
    return {
      type: 'tool-result',
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      status: result.output.type === 'error-text'
        || result.output.type === 'error-json'
        || result.output.type === 'execution-denied'
        ? 'error'
        : 'ok',
      payloadHash: outputHash(result.output),
    };
  }
  throw new TypeError(`Copilot does not support ${String(part.type)} prompt parts`);
}

/** Serializes a V3 prompt into the same comparison shape used by Task 5. */
export function v3History(prompt: LanguageModelV3Prompt): SerializedHistory {
  return {
    version: SERIALIZED_HISTORY_VERSION,
    entries: prompt
      .filter(message => message.role !== 'system')
      .map(message => ({
        role: message.role,
        parts: message.content.map(part => serializedPart(part as unknown as Record<string, unknown>)),
      })),
  };
}

/** Extracts one canonical system message and rejects multiple conflicting ones. */
export function v3SystemPrompt(prompt: LanguageModelV3Prompt): string {
  const systems = prompt.filter(message => message.role === 'system');
  if (systems.length > 1) throw new TypeError('Copilot accepts one normalized system message');
  return systems[0]?.content ?? '';
}

/** Builds immutable comparison state for one connector request. */
export function v3ComparisonState(input: {
  prompt: LanguageModelV3Prompt;
  modelId: string;
  reasoningEffort: string | null;
  tools: readonly LanguageModelV3FunctionTool[];
}): TranscriptComparisonState {
  const system = v3SystemPrompt(input.prompt);
  return {
    upstreamModel: input.modelId,
    reasoningEffort: input.reasoningEffort,
    systemPromptHash: hashSystemPrompt(system),
    toolSchemaHash: hashToolSchema(input.tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchemaJson: tool.inputSchema,
    }))),
    history: v3History(input.prompt),
  };
}

/** Reads tool-result parts in transcript order for pending-handler continuation. */
export function v3ToolResults(prompt: LanguageModelV3Prompt): LanguageModelV3ToolResultPart[] {
  return prompt.flatMap(message => (
    message.role === 'tool'
      ? message.content.filter(part => part.type === 'tool-result')
      : []
  )) as LanguageModelV3ToolResultPart[];
}

/** Returns the final user text as the next session turn. */
export function v3LatestUserPrompt(prompt: LanguageModelV3Prompt): string {
  const user = [...prompt].reverse().find(message => message.role === 'user');
  if (user === undefined) throw new TypeError('Copilot request requires a user message');
  const text = user.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n');
  if (text.length === 0) throw new TypeError('Copilot user message requires text');
  return text;
}
