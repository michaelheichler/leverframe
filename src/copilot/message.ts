/**
 * Converts V3 user images into SDK blob attachments.
 * Files remain in memory and never become runtime filesystem paths.
 */

import type { LanguageModelV3Prompt } from '@ai-sdk/provider';

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
  if (part.data instanceof Uint8Array) {
    return {
      type: 'blob',
      data: Buffer.from(part.data).toString('base64'),
      mimeType: part.mediaType,
    };
  }
  if (typeof part.data === 'string') {
    return { type: 'blob', data: part.data, mimeType: part.mediaType };
  }
  throw new TypeError('GitHub Copilot image data must be bytes or base64');
}

/** Collects every user image in transcript order for the current request. */
export function v3ImageAttachments(
  prompt: LanguageModelV3Prompt,
): CopilotBlobAttachment[] {
  return prompt.flatMap(message => (
    message.role === 'user'
      ? message.content.flatMap(part => {
          const attachment = imageAttachment(part as unknown as Record<string, unknown>);
          return attachment === undefined ? [] : [attachment];
        })
      : []
  ));
}

/** Adds attachments only when the request contains images. */
export function copilotMessage(
  prompt: string,
  attachments: CopilotBlobAttachment[],
): CopilotMessageOptions {
  return attachments.length === 0 ? { prompt } : { prompt, attachments };
}
