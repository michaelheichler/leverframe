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

const SESSION_RESTORE_314 = [
  CLAUDE_2_1_226_AGENT_SCHEMA,
  'function restore(h){let P=familyKnown(h);let _=!P?"unknown_family":!Qb(h)&&!ro(h)?"not_allowed":P9(h)?"retired":void 0;return _}',
].join('\n');

function schemaChoices(source: string): string[] {
  const argument = source.match(/model:F\((\[[^\]]+\]|[\w$]+)\)/)?.[1] ?? '';
  const expression = argument.startsWith('[')
    ? argument
    : source.match(new RegExp(`(?:var|let) ${argument}=(\\[[^\\]]+\\])`))?.[1] ?? '[]';
  return JSON.parse(expression) as string[];
}

type SessionRestoreClassifier = (
  family: boolean,
  account: (model: string) => boolean,
  custom: (model: string) => boolean,
  retired: (model: string) => boolean,
  model: string,
) => unknown;

function classifySessionRestore(
  source: string,
  result: { family: boolean; account: boolean; custom: boolean; retired: boolean },
): unknown {
  const expression = source.match(/let _=(.*?);return _/)?.[1] ?? '"unmatched"';
  const classify = new Function(
    'P', 'Qb', 'ro', 'P9', 'h', `return (${expression})`,
  ) as SessionRestoreClassifier;
  return classify(result.family, () => result.account, () => result.custom, () => result.retired, 'candidate-model');
}

const RESUME_MODEL_SITE =
  'function coh(e,t){let r=new Set(qZc.map((i)=>Eo(i))),n=t?ns(t):void 0,o=n?dd(n):void 0;'
  + 'for(let i=e.length-1;i>=0;i--){let s=e[i];if(s?.type!=="assistant")continue;let a=s.message.model,l=fz();'
  + 'let c=!(r.has(Eo(a))||tJe(a)||dd(a)===o)?"unknown_family":!Ek(a)&&!vc(a)?"not_allowed":ypr(a)?"retired":void 0;'
  + 'if(c)return{kind:"declined",model:a,reason:c};return{kind:"ok",model:a}}return{kind:"none"}}';

describe('Claude Code 2.1.226 session-restore model allowlist', () => {
  it('lets an availableModels-allowlisted model pass the unknown_family check', () => {
    const fixture = [CLAUDE_2_1_226_AGENT_SCHEMA, RESUME_MODEL_SITE].join('\n');
    const result = applyLeverframePatches(fixture, CUSTOM_MODEL_CONFIG);

    expect(result.results).toContainEqual({
      status: 'OK',
      name: 'PATCH 11: session-restore model family allowlist',
    });
    expect(result.content).toContain(
      '!(r.has(Eo(a))||tJe(a)||dd(a)===o||/*ccpatch:resume-model*/vc(a))?"unknown_family":!Ek(a)&&!vc(a)?"not_allowed":ypr(a)?"retired":void 0;',
    );

    const reapplied = applyLeverframePatches(result.content, CUSTOM_MODEL_CONFIG);
    expect(reapplied.content).toBe(result.content);
    expect(reapplied.results).toContainEqual({
      status: 'SKIP',
      name: 'PATCH 11: session-restore model family allowlist',
      extra: 'already patched',
    });
  });

  it('skips without changing source on an older Claude Code version that lacks the resume-model site', () => {
    const olderVersion = CLAUDE_2_1_226_AGENT_SCHEMA;
    const result = applyLeverframePatches(olderVersion, CUSTOM_MODEL_CONFIG);

    expect(result.results).toContainEqual({
      status: 'SKIP',
      name: 'PATCH 11: session-restore model family allowlist',
      extra: 'not present in this Claude Code version',
    });
  });
});

describe('Claude Code 2.1.314 Agent model aliases', () => {
  it('adds configured identities to the shared Agent model choices', () => {
    const source = [
      'var dmi=["sonnet","opus","haiku","fable"];',
      'model:F(dmi).optional().describe(`Optional model override for this agent.`)',
      'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
      'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
    ].join('\n');
    const result = applyLeverframePatches(source, CUSTOM_MODEL_CONFIG);

    expect(schemaChoices(result.content)).toEqual([
      ...schemaChoices(source),
      CUSTOM_MODEL_CONFIG['leverframe:openai-oauth:gpt-5.6-sol'].alias,
    ]);
  });

  it.each([
    {
      name: 'accepts a configured model',
      family: false,
      account: false,
      custom: true,
      retired: false,
      expected: undefined,
    },
    {
      name: 'rejects a model outside every allowlist',
      family: false,
      account: false,
      custom: false,
      retired: false,
      expected: 'unknown_family',
    },
    {
      name: 'rejects a model disallowed by the account',
      family: true,
      account: false,
      custom: false,
      retired: false,
      expected: 'not_allowed',
    },
    {
      name: 'rejects a retired model',
      family: true,
      account: true,
      custom: true,
      retired: true,
      expected: 'retired',
    },
  ])('$name during session restore', ({ family, account, custom, retired, expected }) => {
    const result = applyLeverframePatches(SESSION_RESTORE_314, CUSTOM_MODEL_CONFIG);

    expect(classifySessionRestore(result.content, { family, account, custom, retired }))
      .toBe(expected);
  });

  it('keeps the session restore patch stable when applied again', () => {
    const first = applyLeverframePatches(SESSION_RESTORE_314, CUSTOM_MODEL_CONFIG);
    const second = applyLeverframePatches(first.content, CUSTOM_MODEL_CONFIG);

    expect(second.content).toBe(first.content);
  });
});

