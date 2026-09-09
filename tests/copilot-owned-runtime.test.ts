import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@github/copilot-sdk';
import { useIsolatedTestHome } from './isolated-test-home.js';

const fake = vi.hoisted(() => ({
  start: vi.fn(async () => {}), stop: vi.fn(async () => [] as Error[]), forceStop: vi.fn(async () => {}),
  createSession: vi.fn(async (_config: unknown) => ({
    sessionId: 'fake', send: vi.fn(async () => 'sent'), on: vi.fn(() => () => {}),
    abort: vi.fn(async () => {}), disconnect: vi.fn(async () => {}),
  })),
}));
vi.mock('../src/copilot/runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/copilot/runtime.js')>(),
  createDefaultCopilotRuntime: vi.fn(() => fake),
}));
import { createDefaultCopilotLanguageModel } from '../src/copilot/language-model-default.js';

useIsolatedTestHome('copilot-owned-runtime');
afterEach(() => { vi.clearAllMocks(); });

describe('Copilot owned runtime configuration', () => {
  it.each(['reported', 'thrown'])('forces cleanup after a %s runtime stop failure', async mode => {
    if (mode === 'reported') fake.stop.mockResolvedValueOnce([new Error('stop failed')]);
    else fake.stop.mockRejectedValueOnce(new Error('stop failed'));
    const model = createDefaultCopilotLanguageModel({ modelId: 'fake', gitHubToken: 'fake-token',
      environment: { LEVERFRAME_HOME: process.env.LEVERFRAME_HOME }, nodeVersion: '24.20.0' });
    const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: { copilot: { claudeSessionId: '11111111-1111-4111-8111-111111111111' } } });
    await response.stream.cancel();
    await expect(model.dispose()).rejects.toThrow();
    expect(fake.forceStop).toHaveBeenCalledTimes(1);
  });

  it('explicitly enables SDK streaming and stops the owned runtime on disposal', async () => {
    const model = createDefaultCopilotLanguageModel({ modelId: 'fake', gitHubToken: 'fake-token',
      environment: { LEVERFRAME_HOME: process.env.LEVERFRAME_HOME }, nodeVersion: '24.20.0' });
    const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: { copilot: { claudeSessionId: '11111111-1111-4111-8111-111111111111' } } });
    const config = fake.createSession.mock.calls[0][0] as SessionConfig;
    expect(config.streaming).toBe(true);
    await response.stream.cancel();
    await model.dispose();
    await model.dispose();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the runtime even when session disconnection fails', async () => {
    fake.createSession.mockResolvedValueOnce({ sessionId: 'fake', send: vi.fn(async () => 'sent'),
      on: vi.fn(() => () => {}), abort: vi.fn(async () => {}),
      disconnect: vi.fn(async () => { throw new Error('disconnect failed'); }) });
    const model = createDefaultCopilotLanguageModel({ modelId: 'fake', gitHubToken: 'fake-token',
      environment: { LEVERFRAME_HOME: process.env.LEVERFRAME_HOME }, nodeVersion: '24.20.0' });
    const response = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: { copilot: { claudeSessionId: '11111111-1111-4111-8111-111111111111' } } });
    await response.stream.cancel();
    await expect(model.dispose()).rejects.toThrow('disconnect failed');
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});
