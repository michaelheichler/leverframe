import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { splitToolUseId, serializeToolResultContent } from './proxy-shared.js';
import { ToolResultImageError } from './provider-error.js';
import { decodeOpenAiReasoningSignature } from './reasoning-signature.js';
import {
  anthropicCacheOptions,
  nativeMarkedToolContent,
  nativeUserContent,
  type CacheControl,
} from './anthropic-sdk-cache.js';

export interface AnthropicBlock {
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
  cache_control?: CacheControl;

  _name?: string;
}
export interface AnthropicMsg { role: 'user' | 'assistant' | 'system'; content: string | AnthropicBlock[]; }

function openAiCacheBreakpoint(block: AnthropicBlock, enabled: boolean): Record<string, unknown> | undefined {
  if (!enabled || !block.cache_control) return undefined;
  return { openai: { promptCacheBreakpoint: { mode: 'explicit' } } };
}

function blockCacheOptions(block: AnthropicBlock, openAi: boolean, anthropic: boolean) {
  return anthropic ? anthropicCacheOptions(block.cache_control) : openAiCacheBreakpoint(block, openAi);
}

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
  const openAiSignature = decodeOpenAiReasoningSignature(block.signature);
  if (npm === '@ai-sdk/openai' && !openAiSignature && !text.trim()) return null;

  const part: Record<string, unknown> = { type: 'reasoning', text };
  if (block.signature) {
    if (npm === '@ai-sdk/google' && !openAiSignature) {
      part.providerOptions = { google: { thoughtSignature: block.signature } };
    } else if ((npm === '@ai-sdk/openai' || npm === '@ai-sdk/openai-compatible') && openAiSignature) {
      part.providerOptions = { openai: { reasoningEncryptedContent: openAiSignature } };
    }
  }
  return part;
}

function translateUserBlocks(
  blocks: AnthropicBlock[],
  openAiPromptCacheBreakpoints: boolean,
  anthropicCache = false,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  const toolResults = blocks.filter(b => b.type === 'tool_result');
  const parts: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    const cache = blockCacheOptions(b, openAiPromptCacheBreakpoints, anthropicCache);
    if (b.type === 'text') {
      parts.push({
        type: 'text',
        text: b.text ?? '',
        ...(cache ? { providerOptions: cache } : {}),
      });
    } else if (b.type === 'image') {
      const p = imagePart(b);
      if (p) {
        parts.push({
          ...p,
          ...(cache ? { providerOptions: cache } : {}),
        });
      }
    } else if (anthropicCache && (b.type === 'document' || b.type === 'search_result')) {
      const anchor = `leverframe-native-${randomUUID()}`;
      const nativeBlock = nativeUserContent(b);
      parts.push({ type: 'text', text: anchor, providerOptions: { leverframe: { nativeUserBlock: nativeBlock } } });
    }
  }
  const toolResultImageParts: Array<Record<string, unknown>> = [];
  if (toolResults.length) {
    out.push({
      role: 'tool',
      content: toolResults.map(tr => {
        const nativeContent = anthropicCache ? nativeMarkedToolContent(tr.content) : undefined;
        const options = blockCacheOptions(tr, openAiPromptCacheBreakpoints, anthropicCache);
        return {
          type: 'tool-result', toolCallId: splitToolUseId(tr.tool_use_id ?? '').rawId, toolName: tr._name ?? 'unknown',
          output: { type: 'text', value: nativeContent ? '' : serializeToolResultForModel(tr, toolResultImageParts) },
          ...((options || nativeContent) ? { providerOptions: { ...options,
            ...(nativeContent ? { leverframe: { nativeToolResultContent: nativeContent } } : {}) } } : {}),
        };
      }),
    } as unknown as ModelMessage);
  }
  const userParts = [...toolResultImageParts, ...parts];
  if (userParts.length) out.push({ role: 'user', content: userParts } as unknown as ModelMessage);
  return out;
}

export function translateMessages(
  messages: AnthropicMsg[],
  npm: string,
  openAiPromptCacheBreakpoints = false,
): ModelMessage[] {
  const isGoogle = npm === '@ai-sdk/google';
  const anthropicCache = npm === '@ai-sdk/anthropic';
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    const blocks: AnthropicBlock[] = typeof msg.content === 'string'
      ? [{ type: 'text', text: msg.content }]
      : msg.content ?? [];
    if (msg.role === 'system') {
      for (const block of blocks) {
        if (block.type !== 'text' || !block.text?.trim()) continue;
        out.push({
          role: 'system',
          content: block.text,
          ...(blockCacheOptions(block, openAiPromptCacheBreakpoints, anthropicCache)
            ? { providerOptions: blockCacheOptions(block, openAiPromptCacheBreakpoints, anthropicCache) } : {}),
        } as unknown as ModelMessage);
      }
    } else if (msg.role === 'user') {
      out.push(...translateUserBlocks(blocks, openAiPromptCacheBreakpoints, anthropicCache));
    } else if (msg.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          parts.push({ type: 'text', text: b.text ?? '', ...(anthropicCache && anthropicCacheOptions(b.cache_control)
            ? { providerOptions: anthropicCacheOptions(b.cache_control) } : {}) });
        } else if (b.type === 'thinking') {
          const part = thinkingToSdkPart(b, npm);
          if (part) parts.push(part);
        } else if (b.type === 'tool_use' && b.id) {
          const { rawId, thoughtSignature } = splitToolUseId(b.id);
          const part: Record<string, unknown> = {
            type: 'tool-call', toolCallId: rawId, toolName: b.name, input: b.input ?? {},
          };
          if (thoughtSignature && isGoogle) part.providerOptions = { google: { thoughtSignature } };
          if (anthropicCache && b.cache_control) part.providerOptions = anthropicCacheOptions(b.cache_control);
          parts.push(part);
        }
      }
      if (parts.length) out.push({ role: 'assistant', content: parts } as unknown as ModelMessage);
    }
  }
  return out;
}
