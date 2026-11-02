/** Because proactive percentages need provider-verified window limits. */
import { expect, it } from 'vitest';
import { anthropicCapacity, codexCapacity, codexEventCapacity } from '../src/account-pool-telemetry.js';

it('records an Anthropic remaining percentage only with a valid corresponding limit', () => {
  const observations = anthropicCapacity(new Headers({
    'anthropic-ratelimit-requests-limit': '120',
    'anthropic-ratelimit-requests-remaining': '6',
  }), 'fixture-account', 100);

  expect(observations).toMatchObject([{
    dimension: 'anthropic:requests', remaining: { value: 6, limit: 120, unit: 'anthropic:requests' },
  }]);
});

it('keeps Anthropic remaining unknown as a percentage when the limit header is absent', () => {
  const observations = anthropicCapacity(new Headers({
    'anthropic-ratelimit-requests-remaining': '10',
  }), 'fixture-account', 100);

  expect(observations).toHaveLength(1);
  expect(observations[0]!.remaining).toEqual({ value: 10, unit: 'anthropic:requests' });
});

it.each(['', '0', '-2', '10.5', '1e3', '9007199254740992', '9'])(
  'keeps Anthropic remaining unknown as a percentage for invalid limits (%s)', rawLimit => {
    const observations = anthropicCapacity(new Headers({
      'anthropic-ratelimit-requests-remaining': '10',
      'anthropic-ratelimit-requests-limit': rawLimit,
    }), 'fixture-account', 100);

    expect(observations).toHaveLength(1);
    expect(observations[0]!.remaining).toEqual({ value: 10, unit: 'anthropic:requests' });
  },
);

it('adds the verified percent limit to a dynamic Codex response-header window', () => {
  const observations = codexCapacity(new Headers({
    'x-codex-workspace-weekly-secondary-used-percent': '92.5',
    'x-codex-workspace-weekly-secondary-window-minutes': '10080',
  }), 'fixture-account', 100);

  expect(observations).toMatchObject([{
    dimension: expect.stringContaining('10080'),
    remaining: { value: 7.5, limit: 100 },
  }]);
});

it('retains a measured zero percent remaining value against a verified Codex limit', () => {
  const observations = codexCapacity(new Headers({
    'x-codex-workspace-weekly-secondary-used-percent': '100',
    'x-codex-workspace-weekly-secondary-window-minutes': '10080',
  }), 'fixture-account', 100);

  expect(observations).toMatchObject([{
    remaining: { value: 0, limit: 100 },
  }]);
});

it('accepts a custom weekly-only Codex event limit ID with a verified percent cap', () => {
  const observations = codexEventCapacity(JSON.stringify({
    type: 'codex.rate_limits', metered_limit_name: 'weekly-pool-fixture',
    rate_limits: { secondary: { used_percent: 94, window_minutes: 10080 } },
  }), 'fixture-account', 100);

  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    dimension: expect.stringContaining('weekly_pool_fixture'),
    remaining: { value: 6, limit: 100 },
  });
});
