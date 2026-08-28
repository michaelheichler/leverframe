import { describe, expect, it } from 'vitest';

import { applyLeverframeIntegrationToModules } from '../src/claude-model-integration.js';
import { buildModuleReplacements, bytecodeForReplacement, isChunkModule, sourceForInvalidatedBytecode } from '../src/claude-bundle-native.js';
import { classifyClaudeExecutable } from '../src/claude-bundle.js';

describe('native Claude module graph', () => {
  it('detects native formats structurally instead of by Claude version', () => {
    expect(classifyClaudeExecutable(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe('native');
    expect(classifyClaudeExecutable(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe('native');
    expect(classifyClaudeExecutable(Buffer.from('#!/usr/bin/env node\n'))).toBe('script');
  });
  it('recognizes code-split JavaScript chunks without claiming native modules', () => {
    expect(isChunkModule('/$bunfs/root/chunk-zrs5zyqa.js')).toBe(true);
    expect(isChunkModule('B:/~BUN/root/chunk-b08jpphw.js')).toBe(true);
    expect(isChunkModule('/$bunfs/root/image-processor.node')).toBe(false);
  });

  it('refuses to write an incomplete module set', () => {
    expect(() => buildModuleReplacements(
      [['/$bunfs/root/cli', 'loader']],
      ['/$bunfs/root/cli', '/$bunfs/root/chunk-a.js'],
    )).toThrow(/missing 1 module/);
  });

  it('preserves bytecode for unchanged modules and clears it only for changed source', () => {
    const bytecode = Buffer.from('compiled');
    expect(bytecodeForReplacement(Buffer.from('same'), Buffer.from('same'), bytecode)).toBe(bytecode);
    expect(bytecodeForReplacement(Buffer.from('old'), Buffer.from('new'), bytecode)).toHaveLength(0);
  });

  it('removes Bun bytecode source markers when falling back to source parsing', () => {
    expect(sourceForInvalidatedBytecode(Buffer.from('// @bun @bytecode\nlet x=1'))).toEqual(Buffer.from('let x=1'));
    const plain = Buffer.from('let x=1');
    expect(sourceForInvalidatedBytecode(plain)).toBe(plain);
  });
});

describe('Claude model integration across a code-split bundle', () => {
  it('finds integration targets outside the entry loader and preserves module boundaries', () => {
    const modules = [
      {
        name: '/$bunfs/root/cli',
        content: '// @bun @bytecode\nimport "/$bunfs/root/chunk-agent.js";',
      },
      {
        name: '/$bunfs/root/chunk-agent.js',
        content: [
          '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`+(flag?" extra":""))',
          'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
          'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
          'function G(e,o,t){let s=T(Nv()),r=(s==="opus"||s==="sonnet")&&s!==t?[s,t]:[t];for(let p of r)en(e,p,o);return e}',
          'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}',
          'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
          'function IXe(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
          'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
          'function ait(e){return ww(lo(e))?.default_effort??"high"}',
          'async call({prompt:e,subagent_type:t,description:r,model:o,run_in_background:u,name:p,isolation:g,cwd:T},E,R,M,D){let B=o,mn=jk(D8(rn,sn),sn,B,fe);E.agentLifecycle.markTypeInvoked(rn.agentType);}',
        ].join('\n'),
      },
    ];

    const outcome = applyLeverframeIntegrationToModules(modules, {
      'leverframe:openai:gpt-5.6': { alias: 'sol' },
    });

    expect(outcome.modules[0]).toEqual(modules[0]);
    expect(outcome.modules[1]?.content).toContain('"sol"');
    expect(outcome.modules[1]?.content).toContain('value:"sol"');
    expect(outcome.modules[1]?.content).toContain('Routing successful. Model');
    expect(outcome.modules[1]?.content).toContain('ccintegration:routing');
    expect(outcome.results.some(result => result.status === 'FAIL')).toBe(false);
    expect(outcome.results.every(result => !result.name.includes('PATCH'))).toBe(true);
    expect(outcome.changedModules).toEqual(['/$bunfs/root/chunk-agent.js']);
  });

  it('rejects an incomplete integration instead of returning a partial result', () => {
    expect(() => applyLeverframeIntegrationToModules([
      { name: '/$bunfs/root/cli', content: modulesWithoutRoutingSite() },
    ], { 'leverframe:openai:gpt-5.6': { alias: 'sol' } })).toThrow(/incompatible/i);
  });
});

function modulesWithoutRoutingSite(): string {
  return [
    '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent.`)',
    'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
    'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
    'function G(e,o,t){let s=T(Nv()),r=(s==="opus"||s==="sonnet")&&s!==t?[s,t]:[t];for(let p of r)en(e,p,o);return e}',
    'async call({prompt:e,subagent_type:t,description:r,model:o,run_in_background:u,name:p,isolation:g,cwd:T},E,R,M,D){E.agentLifecycle.markTypeInvoked(rn.agentType);}',
  ].join('\n');
}
