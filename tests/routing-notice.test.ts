import { describe, expect, it } from 'vitest';
import { formatRoutingNotice, ROUTING_NOTICE_MARKER } from '../src/routing-notice.js';

const ANSI_ESCAPE = String.fromCharCode(0x1b);

describe('formatRoutingNotice', () => {
  it.each([
    ['claude-sonnet', 'high', 'Routing successful. Model claude-sonnet with Reasoning high'],
    ['model-a', 7, 'Routing successful. Model model-a with Reasoning 7'],
    ['model\nname\tvariant', '\thigh\npriority', 'Routing successful. Model model name variant with Reasoning high priority'],
    ['  model-a  ', '  high  ', 'Routing successful. Model model-a with Reasoning high'],
  ])('formats normalized text', (modelDisplay, effort, expected) => {
    expect(formatRoutingNotice({ modelDisplay, effort }).text).toBe(expected);
  });

  it('returns styled segments that concatenate to the plain text', () => {
    const result = formatRoutingNotice({ modelDisplay: 'model-a', effort: 'high' });

    expect(result.segments.map((segment) => segment.text).join('')).toBe(result.text);
    expect(result.segments).toEqual([
      { text: 'Routing successful. Model ' },
      { text: 'model-a', color: 'suggestion', bold: true },
      { text: ' with Reasoning ' },
      { text: 'high', color: 'success', bold: true },
    ]);
  });

  it('styles a string effort as a success segment', () => {
    const result = formatRoutingNotice({ modelDisplay: 'model-a', effort: 'balanced' });

    expect(result.segments[3]).toEqual({ text: 'balanced', color: 'success', bold: true });
  });

  it('does not include ANSI escape sequences', () => {
    const result = formatRoutingNotice({ modelDisplay: 'model-a', effort: 'high' });

    expect(result.text).not.toContain(ANSI_ESCAPE);
    for (const segment of result.segments) {
      expect(segment.text).not.toContain(ANSI_ESCAPE);
    }
  });

  it('exports the routing notice marker value', () => {
    expect(ROUTING_NOTICE_MARKER).toBe('/*ccpatch:routing-notice*/');
  });
});
