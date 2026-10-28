import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_MODELS_PAGE_LIMIT,
  anthropicRowToCachedModel,
  type AnthropicModelRow,
} from '../src/registry/anthropic-model-list.js';
import { fetchAnthropicModels } from '../src/registry/anthropic-models-fetch.js';

function modelRow(overrides: Partial<AnthropicModelRow> = {}): AnthropicModelRow {
  return {
    id: 'claude-fixture-model',
    max_input_tokens: 240_000,
    max_tokens: 12_000,
    ...overrides,
  };
}

describe('Anthropic model names', () => {
  it.each([
    { display_name: 'Display label', name: 'Legacy label', expectedName: 'Display label' },
    { display_name: undefined, name: 'Legacy label', expectedName: 'Legacy label' },
    { display_name: undefined, name: undefined, expectedName: 'claude-fixture-model' },
  ])('chooses the best available model name from $display_name and $name', ({ expectedName, ...names }) => {
    const row = modelRow(names);

    const model = anthropicRowToCachedModel(row, 'https://provider.invalid');

    expect(model?.name).toBe(expectedName);
  });
});

describe('Anthropic model limits', () => {
  it('preserves distinct input and output limits from the provider', () => {
    const row = modelRow();

    const model = anthropicRowToCachedModel(row, 'https://provider.invalid');

    expect(model).toMatchObject({
      contextWindow: row.max_input_tokens,
      inputTokenLimit: row.max_input_tokens,
      outputTokenLimit: row.max_tokens,
      contextWindowUnconfirmed: undefined,
    });
  });

  it.each([null, undefined, 0, -1])('leaves unavailable token limits %s unconfirmed', limit => {
    const row = modelRow({ max_input_tokens: limit, max_tokens: limit });

    const model = anthropicRowToCachedModel(row, 'https://provider.invalid');

    expect(model).toMatchObject({
      contextWindow: undefined,
      inputTokenLimit: undefined,
      outputTokenLimit: undefined,
      contextWindowUnconfirmed: true,
    });
  });
});

describe('Anthropic model lifecycles', () => {
  it.each([undefined, 'active'])('keeps a model with lifecycle %s available', lifecycle => {
    const row = modelRow({ lifecycle });

    const model = anthropicRowToCachedModel(row, 'https://provider.invalid');

    expect(model?.id).toBe(row.id);
  });

  it.each(['deprecated', 'retired'])('excludes models with lifecycle %s', lifecycle => {
    const row = modelRow({ lifecycle });

    const model = anthropicRowToCachedModel(row, 'https://provider.invalid');

    expect(model).toBeUndefined();
  });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Anthropic model pagination', () => {
  it('collects all pages using the server cursor and stops on the final page', async () => {
    const baseUrl = 'http://127.0.0.1:18765';
    const apiKey = randomUUID();
    const firstRow = modelRow({ id: 'claude-page-one' });
    const secondRow = modelRow({ id: 'claude-page-two' });
    const cursor = 'page-one-end';
    const workspaceId = 'wrkspc_page_fixture';
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ data: [firstRow], has_more: true, last_id: cursor }))
      .mockResolvedValueOnce(Response.json({ data: [secondRow], has_more: false, last_id: secondRow.id }));

    const result = await fetchAnthropicModels(baseUrl, apiKey, {
      'X-Fixture-Plan': 'test-plan',
      'anthropic-workspace-id': workspaceId,
    });

    expect(result.error).toBeUndefined();
    expect(result.models.map(model => model.id)).toEqual([firstRow.id, secondRow.id]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const expectedOptions = {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        Accept: 'application/json',
        'X-Fixture-Plan': 'test-plan',
        'anthropic-workspace-id': workspaceId,
      },
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    };
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `${baseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`,
      expectedOptions,
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `${baseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}&after_id=${cursor}`,
      expectedOptions,
    );
  });
});

function expectedListRequest(apiKey: string) {
  return {
    method: 'GET',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
    redirect: 'manual',
    signal: expect.any(AbortSignal),
  };
}

describe('Anthropic model discovery error hints', () => {
  const upstreamMessage = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';

  it.each([upstreamMessage, `  ${upstreamMessage}  `])('returns the upstream workspace guidance with whitespace trimmed (%#)', async message => {
    const apiKey = randomUUID();
    const baseUrl = 'http://127.0.0.1:18765';
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      type: 'error', error: { type: 'invalid_request_error', message },
    }, { status: 400 }));

    const result = await fetchAnthropicModels(baseUrl, apiKey);

    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/list models.*HTTP 400/i);
    expect(result.hint).toBe(upstreamMessage);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`, expectedListRequest(apiKey),
    );
  });

  it('retains endpoint guidance when an HTTP error body is not JSON', async () => {
    const apiKey = randomUUID();
    const baseUrl = 'http://127.0.0.1:18765';
    vi.mocked(fetch).mockResolvedValueOnce(new Response('<html>Request rejected</html>', { status: 400 }));

    const result = await fetchAnthropicModels(baseUrl, apiKey);

    expect(result.error).toMatch(/list models.*HTTP 400/i);
    expect(result.hint).toMatch(/base URL.*Anthropic-compatible \/v1\/models/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`, expectedListRequest(apiKey),
    );
  });
});

describe('Anthropic model discovery authentication', () => {
  it.each([401, 403])('reports a rejected API key for HTTP %s without returning models', async status => {
    const baseUrl = 'http://127.0.0.1:18765';
    const apiKey = randomUUID();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));

    const result = await fetchAnthropicModels(baseUrl, apiKey);

    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/api key.*reject/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/v1/models?limit=${ANTHROPIC_MODELS_PAGE_LIMIT}`,
      {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        },
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      },
    );
  });
});
