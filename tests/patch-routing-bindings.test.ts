import { describe, expect, it } from 'vitest';
import { requireRoutingBinding } from '../src/patch-routing-bindings.js';

const boundary = '\n//#__leverframe_claude_module__:';
const definition = /function (readEffort)\(context\)\{return context.effort\}/;
const reader = 'function readEffort(context){return context.effort}';
const consumer = boundary + 'agent.js\nasync function*runner(){}';

function requireFrom(source: string): string | undefined {
  return requireRoutingBinding(source, definition, source.indexOf('async function'));
}

describe('runtime routing binding', () => {
  it('requires the exported alias when the consumer chunk does not import it', () => {
    const source = boundary + 'effort.js\n' + reader + 'export{readEffort as exported};' + consumer;
    expect(requireFrom(source)).toBe('import.meta.require("effort.js").exported');
  });

  it('requires nothing when the reader lives in the consumer chunk', () => {
    expect(requireFrom(boundary + 'agent.js\n' + reader + 'async function*runner(){}')).toBeUndefined();
  });

  it('requires nothing when the owner chunk keeps the reader private', () => {
    expect(requireFrom(boundary + 'effort.js\n' + reader + 'export{other};' + consumer)).toBeUndefined();
  });

  it('requires nothing when the reader definition is ambiguous', () => {
    const source = boundary + 'effort.js\n' + reader + reader + 'export{readEffort};' + consumer;
    expect(requireFrom(source)).toBeUndefined();
  });
});
