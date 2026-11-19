/** Because proactive percentages need provider-verified window limits. */
import { expect, it } from 'vitest';
import { anthropicCapacity } from '../src/account-pool-telemetry.js';

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
