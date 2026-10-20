import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePreferences } from '../src/config.js';
import { buildDesiredPatchConfig, computePatchConfigHash } from '../src/patcher.js';
import { applyLeverframePatches, shortDisplayName, type PatchScriptModelConfig } from '../src/patch-transforms.js';
import type { FavoriteModel, LocalProvider } from '../src/types.js';

const CLAUDE_FIXTURE = [
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)',
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
].join('\n');

function patch(config: PatchScriptModelConfig): string {
  return applyLeverframePatches(CLAUDE_FIXTURE, config).content;
}

function parseArray(source: string, pattern: RegExp): string[] {
  const literal = pattern.exec(source)?.[1];
  expect(literal).toBeDefined();
  return JSON.parse(literal ?? '[]') as string[];
}

function agentEnum(source: string): string[] {
  return parseArray(source, /\.enum\((\[[^\]]*\])\)\.optional\(\)/);
}

function knownAliases(source: string): string[] {
  return parseArray(source, /var KNOWN=(\[[^\]]*\])/);
}

function pickerValues(source: string): string[] {
  const encoded = /\/\*ccpatch:model-picker-options\*\/var __lfcModelPickerOptions=JSON\.parse\(("(?:[^"\\]|\\.)*")\)/
    .exec(source)?.[1];
  expect(encoded).toBeDefined();
  const options = JSON.parse(JSON.parse(encoded ?? '"[]"') as string) as Array<{ value: string }>;
  return options.map(option => option.value);
}

const PICKER_ONLY_CONFIG: PatchScriptModelConfig = {
  'leverframe:openai:shown': { display: 'Shown (OpenAI)' },
  'leverframe:openai:hidden': { display: 'Hidden (OpenAI)', pickerOnly: true },
};

describe('Agent tool model list', () => {
  it('keeps a picker-only model out of the Agent tool model enum', () => {
    const out = patch(PICKER_ONLY_CONFIG);

    expect(agentEnum(out)).toEqual(['sonnet', 'opus', 'haiku', 'fable', 'leverframe:openai:shown']);
  });

  it('keeps a picker-only model out of the Agent tool description', () => {
    const out = patch(PICKER_ONLY_CONFIG);

    expect(out).toContain('Additional custom models: leverframe:openai:shown = Shown.');
  });

  it('still accepts a picker-only model in the known-alias validator', () => {
    const out = patch(PICKER_ONLY_CONFIG);

    expect(knownAliases(out)).toContain('leverframe:openai:hidden');
  });

  it('still offers a picker-only model in the /model picker', () => {
    const out = patch(PICKER_ONLY_CONFIG);

    expect(pickerValues(out)).toContain('leverframe:openai:hidden');
  });

  it('lists only the alias when the short display name repeats it', () => {
    const out = patch({ 'leverframe:zai:glm-5.3': { alias: 'glm-5.3', display: 'GLM-5.3 (z.ai (Coding Plan))' } });

    expect(out).toContain('Additional custom models: glm-5.3.');
  });
});

describe('shortDisplayName', () => {
  it.each([
    ['GPT-6 Luna (OpenAI (ChatGPT))', 'GPT-6 Luna'],
    ['Qwen Coder (free) (OpenRouter)', 'Qwen Coder (free)'],
    ['Plain Name', 'Plain Name'],
    ['(OpenAI)', '(OpenAI)'],
    [undefined, undefined],
  ])('shortens %s to %s', (display, expected) => {
    expect(shortDisplayName(display)).toBe(expected);
  });
});

describe('computePatchConfigHash for picker-only models', () => {
  it('changes when only the picker-only flag flips on one entry', () => {
    const agentVisible = { 'leverframe:p:m1': { context: 1000 }, 'leverframe:p:m2': { context: 1000 } };
    const pickerOnly = { ...agentVisible, 'leverframe:p:m2': { context: 1000, pickerOnly: true } };

    expect(computePatchConfigHash(pickerOnly)).not.toBe(computePatchConfigHash(agentVisible));
  });
});

describe('buildDesiredPatchConfig Agent tool scope', () => {
  let home: string;
  const previousHome = process.env['LEVERFRAME_HOME'];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'leverframe-agent-model-list-'));
    process.env['LEVERFRAME_HOME'] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
    else process.env['LEVERFRAME_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function catalogModel(id: string): LocalProvider['models'][number] {
    return { id, name: id, family: 'test', brand: 'Test', modelFormat: 'openai', upstreamModelId: id };
  }

  function freshCatalog(): LocalProvider[] {
    return [{
      id: 'openai-oauth',
      name: 'OpenAI (ChatGPT)',
      apiKey: '',
      models: [catalogModel('favorite'), catalogModel('aliased'), catalogModel('other')],
    }];
  }

  function savePrefs(favoriteModels: FavoriteModel[]): void {
    savePreferences({
      favoriteModels,
      modelAliases: [{ name: 'ali', providerId: 'openai-oauth', modelId: 'aliased' }],
    });
  }

  function desiredHash(favoriteModels: FavoriteModel[]): string {
    savePrefs(favoriteModels);
    return computePatchConfigHash(buildDesiredPatchConfig(freshCatalog()).config);
  }

  it('marks only a catalog model that is neither favorited nor aliased as picker-only', () => {
    savePrefs([{ providerId: 'openai-oauth', modelId: 'favorite' }]);

    const desired = buildDesiredPatchConfig(freshCatalog());

    expect(Object.fromEntries(Object.entries(desired.config).map(([id, entry]) => [id, entry.pickerOnly === true])))
      .toEqual({
        'leverframe:openai-oauth:favorite': false,
        'leverframe:openai-oauth:aliased': false,
        'leverframe:openai-oauth:other': true,
      });
  });

  it('offers the Agent tool the favorite and the alias but not the other catalog model', () => {
    savePrefs([{ providerId: 'openai-oauth', modelId: 'favorite' }]);

    const out = patch(buildDesiredPatchConfig(freshCatalog()).config);

    expect(agentEnum(out)).toEqual(['sonnet', 'opus', 'haiku', 'fable', 'leverframe:openai-oauth:favorite', 'ali']);
  });

  it('changes the desired config hash when only the favorites change', () => {
    const before = desiredHash([{ providerId: 'openai-oauth', modelId: 'favorite' }]);

    const after = desiredHash([{ providerId: 'openai-oauth', modelId: 'other' }]);

    expect(after).not.toBe(before);
  });
});
