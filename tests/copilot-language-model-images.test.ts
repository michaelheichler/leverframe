import { describe, expect, it, vi } from 'vitest';
import {
  buildDeps,
  callOptions,
  collectStreamParts,
  loadCopilotLanguageModelModule,
  readableStreamFromParts,
} from './fixtures/copilot-connector-contract.js';

const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('createCopilotLanguageModel image ingress', () => {
  it('passes downloaded image bytes as an SDK blob attachment', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, session } = buildDeps({
      bridgeSessionEvents: () => readableStreamFromParts([]),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await collectStreamParts((await model.doStream(callOptions({
      claudeSessionId: SESSION_ID,
      prompt: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
        ],
      }],
    }))).stream);

    expect(session.send).toHaveBeenCalledWith({
      prompt: 'describe this',
      attachments: [{ type: 'blob', data: 'AQID', mimeType: 'image/png' }],
    });
    expect(model.supportedUrls).toEqual({});
  });

  it('preserves image attachments during explicit transcript resync', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, session } = buildDeps({
      bridgeSessionEvents: () => readableStreamFromParts([]),
      classifyTranscript: vi.fn(() => ({
        kind: 'resync' as const,
        reason: 'compaction' as const,
      })),
    });
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);
    const prompt = [{
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'describe this' },
        { type: 'file' as const, data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
      ],
    }];
    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_ID, prompt }))).stream);

    await collectStreamParts((await model.doStream(callOptions({ claudeSessionId: SESSION_ID, prompt }))).stream);

    expect(session.send).toHaveBeenLastCalledWith({
      prompt: expect.stringContaining('leverframe-copilot-history-v1'),
      attachments: [{ type: 'blob', data: 'AQID', mimeType: 'image/png' }],
    });
  });

  it('rejects non-image files before loading the runtime', async () => {
    const { createCopilotLanguageModel } = await loadCopilotLanguageModelModule();
    const { deps, getRuntimeSpy } = buildDeps();
    const model = createCopilotLanguageModel({ modelId: 'claude-sonnet-4-6' }, deps);

    await expect(model.doStream(callOptions({
      claudeSessionId: SESSION_ID,
      prompt: [{
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          { type: 'file', data: 'ZmFrZQ==', mediaType: 'application/pdf' },
        ],
      }],
    }))).rejects.toThrow(/image|file/i);
    expect(getRuntimeSpy).not.toHaveBeenCalled();
  });
});
