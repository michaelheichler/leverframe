import { describe, expect, it } from 'vitest';
import { parseOpenCodeGoMetadata } from '../src/registry/supplier-metadata.js';

describe('parseOpenCodeGoMetadata', () => {
  it('derives model protocol and usage multiplier from supplier MDX tables', () => {
    const metadata = parseOpenCodeGoMetadata([
      'Subscription costs **$7/month**.',
      '| Model | Input | Output | Cached Read | Cached Write | Usage |',
      '| --- | --- | --- | --- | --- | --- |',
      '| Future Model | $0.2 | $0.8 | $0.1 | - | $35 |',
      '| Model | Model ID | Endpoint | AI SDK Package |',
      '| --- | --- | --- | --- |',
      '| Future Model | future-model | `https://example.test/v1/messages` | `@ai-sdk/anthropic` |',
    ].join('\n'));

    expect(metadata.get('future-model')).toEqual({
      npm: '@ai-sdk/anthropic',
      usageMultiplier: 5,
      cost: { input: 0.2, output: 0.8, cache_read: 0.1 },
    });
  });
});
