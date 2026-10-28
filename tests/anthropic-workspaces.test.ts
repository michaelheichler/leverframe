import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listAnthropicWorkspaces } from '../src/registry/anthropic-workspaces.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('available Anthropic workspaces', () => {
  it.each([
    {
      label: 'archived workspaces',
      rows: [
        { id: 'wrkspc_active', name: 'Active workspace', archived_at: null },
        { id: 'wrkspc_archived', name: 'Archived workspace', archived_at: '2026-01-01T00:00:00Z' },
      ],
      expected: [{ id: 'wrkspc_active', name: 'Active workspace' }],
    },
    { label: 'unusable IDs', rows: [{ name: 'Missing ID' }, { id: '   ' }, { id: 42 }], expected: [] },
    {
      label: 'missing display names',
      rows: [{ id: 'wrkspc_unnamed' }, { id: 'wrkspc_blank_name', name: '   ' }],
      expected: [{ id: 'wrkspc_unnamed', name: 'wrkspc_unnamed' }, { id: 'wrkspc_blank_name', name: 'wrkspc_blank_name' }],
    },
    {
      label: 'surrounding whitespace',
      rows: [{ id: '  wrkspc_trimmed  ', name: '  Trimmed workspace  ' }],
      expected: [{ id: 'wrkspc_trimmed', name: 'Trimmed workspace' }],
    },
  ])('returns selectable workspace identities after handling $label', async ({ rows, expected }) => {
    const key = randomUUID();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ data: rows }));

    const result = await listAnthropicWorkspaces('https://workspaces.invalid/v1/', key);

    expect(result).toEqual({ ok: true, workspaces: expected });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/workspaces\.invalid\/v1\/organizations\/workspaces\?limit=[1-9]\d*$/),
      {
        method: 'GET',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', Accept: 'application/json' },
        redirect: 'manual', signal: expect.any(AbortSignal),
      },
    );
  });
});
