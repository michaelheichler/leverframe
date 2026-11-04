import { describe, expect, it } from 'vitest';
import { parseOpenCodeGoMetadata } from '../src/registry/supplier-metadata.js';

const NPM = '@ai-sdk/openai-compatible';

const PRICING_HEADER = [
  '  | Model | Input | Output | Cached Read | Cached Write | Monthly limit |',
  '  | --- | --- | --- | --- | --- | --- |',
];

const OPEN_CODE_GO_DOC = [
  '# OpenCode Go',
  '',
  '| Plan | Price | Seats |',
  '| --- | --- | --- |',
  '| Go | **$10/month** | 1 |',
  '| Go Plus | **$40/month** | 1 |',
  '| Go Teams | **$20/member/month** | 5 |',
  '',
  '## Go pricing',
  '',
  ...PRICING_HEADER,
  '  | GLM-5.3-Flash | $0.50 | $2.00 | $0.05 | - | **$60** |',
  '  | DeepSeek V4.1 Flash (Off-Peak) | $0.15 | $0.60 | $0.003 | - | **$100** |',
  '  | DeepSeek V4.1 Flash (Peak) | $0.30 | $1.20 | $0.006 | - | **$100** |',
  '  | Beam Free | Free | Free | Free | - | **Unlimited** |',
  '',
  '## Go Plus pricing',
  '',
  ...PRICING_HEADER,
  '  | GLM-5.3-Flash | $0.50 | $2.00 | $0.05 | - | **$240** |',
  '  | DeepSeek V4.1 Flash (Off-Peak) | $0.15 | $0.60 | $0.003 | - | **$200** |',
  '  | DeepSeek V4.1 Flash (Peak) | $0.30 | $1.20 | $0.006 | - | **$200** |',
  '  | Beam Free | Free | Free | Free | - | **Unlimited** |',
  '',
  '## Endpoints',
  '',
  '| Model | Model ID | Endpoint | AI SDK Package |',
  '| --- | --- | --- | --- |',
  `| GLM-5.3-Flash | \`glm-5.3-flash\` | https://go.example/v1/chat/completions | \`${NPM}\` |`,
  `| DeepSeek V4.1 Flash | \`deepseek-v4.1-flash\` | https://go.example/v1/chat/completions | \`${NPM}\` |`,
  `| Beam Free | \`beam-free\` | https://go.example/v1/chat/completions | \`${NPM}\` |`,
].join('\n');

describe('parseOpenCodeGoMetadata', () => {
  it('expresses a monthly limit as a multiple of the first plan price', () => {
    const metadata = parseOpenCodeGoMetadata(OPEN_CODE_GO_DOC);

    expect(metadata.get('glm-5.3-flash')?.usageMultiplier).toBe(6);
  });

  it('prices a peak-tiered model from its off-peak row in the first plan', () => {
    const metadata = parseOpenCodeGoMetadata(OPEN_CODE_GO_DOC);

    expect(metadata.get('deepseek-v4.1-flash')).toEqual({
      npm: NPM,
      usageMultiplier: 10,
      cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
    });
  });

  it('reports no usage multiplier for a model with an unlimited allowance', () => {
    const beamFree = parseOpenCodeGoMetadata(OPEN_CODE_GO_DOC).get('beam-free');

    expect(beamFree?.npm).toBe(NPM);
    expect(beamFree?.usageMultiplier).toBeUndefined();
  });
});
