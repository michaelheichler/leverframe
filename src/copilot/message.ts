/**
 * Converts V3 user images into SDK blob attachments.
 * Files remain in memory and never become runtime filesystem paths.
 */

import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { copilotImageBlob } from './image-part.js';

export interface CopilotBlobAttachment {
  type: 'blob';
  data: string;
  mimeType: string;
}

export interface CopilotMessageOptions {
  prompt: string;
  attachments?: CopilotBlobAttachment[];
}

function imageAttachment(part: Record<string, unknown>): CopilotBlobAttachment | undefined {
  if (part.type !== 'file') return undefined;
  if (typeof part.mediaType !== 'string' || !part.mediaType.startsWith('image/')) {
    throw new TypeError('GitHub Copilot accepts only image attachments');
  }
  if (part.data instanceof URL) {
    throw new TypeError('GitHub Copilot image URLs must be downloaded by the AI SDK');
  }
  const data = copilotImageBlob(part.data, part.mediaType);
  if (data === undefined) return undefined;
  return { type: 'blob', data, mimeType: part.mediaType };
}

function userImageAttachments(
  content: LanguageModelV3Prompt[number]['content'],
): CopilotBlobAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap(part => {
    const attachment = imageAttachment(part as unknown as Record<string, unknown>);
    return attachment === undefined ? [] : [attachment];
  });
}

/** Collects every user image in transcript order for the current request. */
export function v3ImageAttachments(
  prompt: LanguageModelV3Prompt,
): CopilotBlobAttachment[] {
  return prompt.flatMap(message => (
    message.role === 'user' ? userImageAttachments(message.content) : []
  ));
}

/** Collects images from the latest user message only. */
export function v3LatestUserImageAttachments(
  prompt: LanguageModelV3Prompt,
): CopilotBlobAttachment[] {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (message.role === 'user') return userImageAttachments(message.content);
  }
  return [];
}

/** Adds attachments only when the request contains images. */
export function copilotMessage(
  prompt: string,
  attachments: CopilotBlobAttachment[],
): CopilotMessageOptions {
  return attachments.length === 0 ? { prompt } : { prompt, attachments };
}
