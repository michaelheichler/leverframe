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

