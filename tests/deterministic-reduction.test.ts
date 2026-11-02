import { describe, expect, it } from 'vitest';
import { estimateAnthropicInputTokens } from '../src/anthropic-endpoints.js';
import { reduceDuplicateToolResults } from '../src/context/deterministic-reduction.js';
import { createContextEvidenceFixture } from './fixtures/context-evidence.js';

type TestBlock = { type: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; [key: string]: unknown };
type TestMessage = { role: string; content: string | TestBlock[] };
type TestRequest = { model: string; system: { type: string; text: string }[]; messages: TestMessage[]; future_field: { keep: boolean } };

const requestWithRepeatedResult = (): TestRequest => ({
  model: 'fixture-model',
  system: [{ type: 'text', text: 'Keep this instruction byte for byte.' }],
  messages: [
    { role: 'user', content: 'Find the same record twice.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'first-call', name: 'lookup', input: { record: 'same' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'first-call', content: 'stable result '.repeat(180) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'second-call', name: 'lookup', input: { record: 'same' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'second-call', content: 'stable result '.repeat(180) }] },
  ],
  future_field: { keep: true },
});

async function reduce(request: ReturnType<typeof requestWithRepeatedResult>, sessionId = 'session-a') {
  const fixture = createContextEvidenceFixture();
  const signal = new AbortController().signal;
  return { fixture, result: await reduceDuplicateToolResults({ request, sessionId, store: fixture.store, signal }) };
}

function getLaterResult(request: TestRequest): TestBlock {
  return (request.messages[4].content as TestBlock[])[0]!;
}

function replaceBlock(request: TestRequest, messageIndex: number, update: (block: TestBlock) => TestBlock): TestRequest {
  const messages = [...request.messages];
  const message = messages[messageIndex]!;
  const content = [...message.content as TestBlock[]];
  content[0] = update(content[0]!);
  messages[messageIndex] = { ...message, content };
  return { ...request, messages };
}

async function closeAfter(fixture: ReturnType<typeof createContextEvidenceFixture>, callback: () => Promise<void>) {
  try {
    await callback();
  } finally {
    fixture.close();
  }
}

describe('duplicate tool result reduction', () => {
  it('retains both tool pairs and replaces only a later identical result with a retrievable reference', async () => {
    const original = requestWithRepeatedResult();
    const { fixture, result } = await reduce(original);
    await closeAfter(fixture, async () => expectReducedReference(original, result.request, fixture.store));
  });

  it.each([
    ['different result bytes', (request: TestRequest) => replaceBlock(request, 4, block => ({ ...block, content: 'different result '.repeat(180) }))],
    ['different tool input', (request: TestRequest) => replaceBlock(request, 3, block => ({ ...block, input: { record: 'different' } }))],
    ['different tool name', (request: TestRequest) => replaceBlock(request, 3, block => ({ ...block, name: 'other' }))],
    ['unresolved tool pair', (request: TestRequest) => replaceBlock(request, 4, block => ({ ...block, tool_use_id: 'missing-call' }))],
    ['multimodal result', (request: TestRequest) => replaceBlock(request, 4, block => ({ ...block, content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] }))],
    ['result too small to save bytes', (request: TestRequest) => replaceBlock(request, 4, block => ({ ...block, content: 'x' }))],
  ])('keeps the exact original request for %s', async (_caseName, mutate) => {
    const original = mutate(requestWithRepeatedResult());
    const { fixture, result } = await reduce(original);
    await closeAfter(fixture, async () => expect(result).toEqual({ request: original, reduced: false }));
  });

  it('keeps user instructions unchanged while reducing duplicate results', async () => {
    const original = requestWithRepeatedResult();
    const instruction = { role: 'user', content: 'Never discard this user instruction.' };
    original.messages.unshift(instruction);
    const { fixture, result } = await reduce(original);
    await closeAfter(fixture, async () => {
      expect(result.reduced).toBe(true);
      expect(result.request.messages[0]).toEqual(instruction);
    });
  });

  it('keeps the request when replacement bytes fall but estimated input tokens do not', async () => {
    const fixture = createContextEvidenceFixture();
    await closeAfter(fixture, async () => {
      const signal = new AbortController().signal;
      const seed = await reduceDuplicateToolResults({ request: requestWithRepeatedResult(), sessionId: 'session-a', store: fixture.store, signal });
      const marker = String(getLaterResult(seed.request).content);
      const candidate = flatEstimateCandidate(marker);
      expect(candidate).toBeDefined();
      const { original, hypothetical } = candidate!;
      expect(Buffer.byteLength(JSON.stringify(hypothetical))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)));
      expect(estimateAnthropicInputTokens(hypothetical)).toBe(estimateAnthropicInputTokens(original));
      const result = await reduceDuplicateToolResults({ request: original, sessionId: 'session-a', store: fixture.store, signal });
      expect(result).toEqual({ request: original, reduced: false });
    });
  });

  it('keeps the original request when evidence persistence fails', async () => {
    const original = requestWithRepeatedResult();
    const fixture = createContextEvidenceFixture({ maxBytes: 1 });
    const result = await reduceDuplicateToolResults({ request: original, sessionId: 'session-a', store: fixture.store, signal: new AbortController().signal });
    await closeAfter(fixture, async () => expect(result).toEqual({ request: original, reduced: false }));
  });

  it('keeps the original request when its abort signal is already set', async () => {
    const original = requestWithRepeatedResult();
    const fixture = createContextEvidenceFixture();
    const controller = new AbortController();
    controller.abort();
    const result = await reduceDuplicateToolResults({ request: original, sessionId: 'session-a', store: fixture.store, signal: controller.signal });
    await closeAfter(fixture, async () => expect(result).toEqual({ request: original, reduced: false }));
  });
});

async function expectReducedReference(original: ReturnType<typeof requestWithRepeatedResult>, reduced: ReturnType<typeof requestWithRepeatedResult>, store: ReturnType<typeof createContextEvidenceFixture>['store']) {
  expect(reduced.messages).toHaveLength(original.messages.length);
  expect(reduced.system).toBe(original.system);
  expect(reduced.future_field).toBe(original.future_field);
  expect(reduced.messages[1]).toEqual(original.messages[1]);
  expect(reduced.messages[2]).toEqual(original.messages[2]);
  expect(reduced.messages[3]).toEqual(original.messages[3]);
  const result = getLaterResult(reduced);
  const reference = String(result.content).match(/'([^']+)'\s*$/m)?.[1];
  expect(result.tool_use_id).toBe('second-call');
  expect(reference).toBeDefined();
  await expect(store.get('session-a', reference!)).resolves.toBe('stable result '.repeat(180));
  expect(Buffer.byteLength(JSON.stringify(reduced))).toBeLessThan(Buffer.byteLength(JSON.stringify(original)));
}

function flatEstimateCandidate(marker: string) {
  const samples = [1, 2, 3].flatMap(savedBytes => [0, 1, 2, 3].map(padding => {
    const content = 'x'.repeat(Buffer.byteLength(marker) + savedBytes);
    const base = requestWithRepeatedResult();
    base.system[0]!.text += 'x'.repeat(padding);
    const original = withResultContent(base, content);
    return { original, hypothetical: withLaterResultContent(original, marker) };
  }));
  return samples.find(({ original, hypothetical }) =>
    Buffer.byteLength(JSON.stringify(hypothetical)) < Buffer.byteLength(JSON.stringify(original))
      && estimateAnthropicInputTokens(original) === estimateAnthropicInputTokens(hypothetical));
}

function withResultContent(request: TestRequest, content: string): TestRequest {
  return withLaterResultContent(withLaterResultContent(request, content, 2), content, 4);
}

function withLaterResultContent(request: TestRequest, content: string, messageIndex = 4): TestRequest {
  const messages = [...request.messages];
  const message = messages[messageIndex]!;
  messages[messageIndex] = { ...message, content: [{ ...(message.content as TestBlock[])[0], content }] };
  return { ...request, messages };
}
