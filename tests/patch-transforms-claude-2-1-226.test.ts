import { describe, expect, it } from 'vitest';
import { applyLeverframePatches } from '../src/patch-transforms.js';

const CLAUDE_2_1_226_AGENT_SCHEMA = [
  'model:Nr(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"]',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
].join('\n');

const CUSTOM_MODEL_CONFIG = {
  'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol' },
};

describe('Claude Code 2.1.226 patch compatibility', () => {
  it('adds custom identities to the function-style Agent model enum', () => {
    const result = applyLeverframePatches(CLAUDE_2_1_226_AGENT_SCHEMA, CUSTOM_MODEL_CONFIG);

    expect(result.content).toContain(
      'model:Nr(["sonnet","opus","haiku","fable","sol"]).optional().describe(',
    );
  });

  it('keeps supporting the legacy enum constructor form', () => {
    const result = applyLeverframePatches(
      CLAUDE_2_1_226_AGENT_SCHEMA.replace('model:Nr(', '.enum('),
      CUSTOM_MODEL_CONFIG,
    );

    expect(result.content).toContain(
      '.enum(["sonnet","opus","haiku","fable","sol"]).optional().describe(',
    );
  });

  it('does not patch a non-Agent enum with the same native identities', () => {
    const result = applyLeverframePatches(
      [
        CLAUDE_2_1_226_AGENT_SCHEMA,
        'other:Nr(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for another tool.`)',
      ].join('\n'),
      CUSTOM_MODEL_CONFIG,
    );

    expect(result.content).toContain(
      'other:Nr(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for another tool.`)',
    );
  });

  it('rejects aliases that collide after case normalization before patching', () => {
    expect(() => applyLeverframePatches(CLAUDE_2_1_226_AGENT_SCHEMA, {
      'leverframe:openai-oauth:gpt-5.6-sol': { alias: 'sol' },
      'leverframe:openai-oauth:gpt-5.6-luna': { alias: 'SOL' },
    })).toThrow('duplicate alias "sol"');
  });

});
