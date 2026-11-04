import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyLeverframePatches, type PatchScriptModelConfig } from '../src/patch-transforms.js';

const CLAUDE_FIXTURE = readFileSync(new URL('./fixtures/claude-patch-sites.js', import.meta.url), 'utf8');

function pickerOptions(config: PatchScriptModelConfig): unknown[] {
  const patched = applyLeverframePatches(CLAUDE_FIXTURE, config).content;
  const encoded = /\/\*ccpatch:model-picker-options\*\/var __lfcModelPickerOptions=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/
    .exec(patched)?.[1];
  expect(encoded).toBeDefined();
  return JSON.parse(JSON.parse(encoded ?? '"[]"') as string) as unknown[];
}

describe('model picker labels and capabilities', () => {
  it('appends capabilities to the model id description of a non-alias entry', () => {
    const id = 'leverframe:opencode-go:glm-5.3-flash';

    const options = pickerOptions({
      [id]: { display: 'GLM-5.3-Flash (OpenCode Go (Subscription))', capabilities: '[1M context, 10x usage]' },
    });

    expect(options).toContainEqual(expect.objectContaining({
      value: id,
      description: `Model ID: ${id} [1M context, 10x usage]`,
    }));
  });

  it.each([
    {
      alias: 'deepseek-v4-flash',
      id: 'leverframe:opencode-go:deepseek-v4.1-flash',
      display: 'DeepSeek V4.1 Flash (OpenCode Go (Subscription))',
      label: 'Deepseek-v4-flash (DeepSeek V4.1 Flash)',
    },
    {
      alias: 'luna',
      id: 'leverframe:openai-oauth:gpt-6-luna',
      display: 'GPT-6 Luna (OpenAI (ChatGPT))',
      label: 'Luna',
    },
  ])('adds the model name to the label of alias $alias only when the alias omits it', ({ alias, id, display, label }) => {
    const options = pickerOptions({ [id]: { alias, display } });

    expect(options).toContainEqual(expect.objectContaining({ value: alias, label }));
  });

  it('keeps the account tag badge on an entry that also has capabilities', () => {
    const id = 'leverframe:opencode-go:glm-5.3-flash';

    const options = pickerOptions({
      [id]: { display: 'GLM-5.3-Flash', accountTag: 'AUTO', capabilities: '[1M context, 10x usage]' },
    });

    expect(options).toContainEqual(expect.objectContaining({ value: id, badge: 'AUTO' }));
  });
});
