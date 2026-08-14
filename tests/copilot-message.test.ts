import type { LanguageModelV3Prompt } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { v3ImageAttachments, v3LatestUserImageAttachments } from '../src/copilot/message.js';

const PNG = 'iVBORw0KGgo=';

function userWithImage(label: string): LanguageModelV3Prompt[number] {
  return {
    role: 'user',
    content: [
      { type: 'text', text: label },
      { type: 'file', data: PNG, mediaType: 'image/png' },
    ],
  };
}

describe('v3LatestUserImageAttachments', () => {
  it('collects images only from the latest user message', () => {
    const prompt: LanguageModelV3Prompt = [
      userWithImage('first'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      userWithImage('second'),
    ];

    expect(v3ImageAttachments(prompt)).toHaveLength(2);
    expect(v3LatestUserImageAttachments(prompt)).toHaveLength(1);
  });

  it('returns no attachments for a text-only latest user message', () => {
    const prompt: LanguageModelV3Prompt = [
      userWithImage('with image'),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
    ];

    expect(v3LatestUserImageAttachments(prompt)).toEqual([]);
  });
});
