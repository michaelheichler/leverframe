import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { ROUTING_NOTICE_FORMAT_SOURCE } from '../src/patch-transforms-routing-notice-format.js';

type NoticeFormatEvent = {
  kind?: 'launch' | 'selector' | 'exhausted' | 'request_completed';
  sessionId: string;
  sequence: number;
  modelId: string;
  revision: number;
  previous?: { providerId: string; modelId: string };
  target?: { providerId: string; modelId: string };
  lastAttempted?: { providerId: string; modelId: string };
  attemptedCount?: number;
  skippedCount?: number;
  reason: string;
  role: 'router' | 'specialist';
  policy: string;
  policyVersion: string;
  effort: string | null;
  estimate: { kind: 'known'; amount: number; snapshot: { source: string; freshness: string } }
    | { kind: 'unknown'; snapshot?: { source: string; freshness: string } };
};

function evaluateNoticeFormat(event: unknown, columns: number, nonce: string): string {
  const scope = runInNewContext(`${ROUTING_NOTICE_FORMAT_SOURCE}\n({ format: __lfFormatNotice })`);
  return (scope as { format: (event: unknown, columns: number, nonce: string) => string })
    .format(event, columns, nonce);
}

function noticeEvent(overrides: Partial<NoticeFormatEvent> = {}): NoticeFormatEvent {
  return {
    sessionId: 'session-fixture', sequence: 3, modelId: 'binding-fixture', revision: 2,
    previous: { providerId: 'provider-before', modelId: 'model-before' },
    target: { providerId: 'provider-after', modelId: 'model-after' },
    reason: 'quota_exhausted', role: 'router', policy: 'cheapest-eligible', policyVersion: 'policy-fixture-v1',
    effort: null, estimate: { kind: 'known', amount: 0.75, snapshot: { source: 'price-fixture', freshness: 'current' } },
    ...overrides,
  };
}

it('preserves nonce and complete model references in the visible notice', () => {
  const formatted = evaluateNoticeFormat(noticeEvent(), 100, 'approval-7');

  const rows = formatted.split('\n');
  expect(rows[0]).toContain('approval-7');
  expect(rows.join('')).toContain('provider-before/model-before');
  expect(rows.join('')).toContain('provider-after/model-after');
});

it('renders non-ASCII and control characters as visible escapes without losing their values', () => {
  const formatted = evaluateNoticeFormat(noticeEvent({
    previous: { providerId: 'prøvider', modelId: 'model\nname' },
  }), 100, 'nonce\u0001');

  expect(formatted).toContain('pr\\u00f8vider');
  expect(formatted).toContain('model\\u000aname');
  expect(formatted).toContain('nonce\\u0001');
});

it('keeps every visible row within the available terminal width', () => {
  const formatted = evaluateNoticeFormat(noticeEvent({
    previous: { providerId: 'provider-name-that-needs-wrapping', modelId: 'model-name-that-needs-wrapping' },
  }), 38, 'approval-token');

  expect(formatted.split('\n').every(row => row.length <= 38)).toBe(true);
});

it('labels the displayed amount as a binding API-equivalent estimate with pricing provenance', () => {
  const formatted = evaluateNoticeFormat(noticeEvent(), 100, 'approval-token');

  expect(formatted).toContain('Binding estimate (API-equivalent): USD 0.75');
  expect(formatted).toContain('price-fixture');
  expect(formatted).toContain('current');
});

it('keeps an unknown estimate explicitly unknown', () => {
  const formatted = evaluateNoticeFormat(noticeEvent({ estimate: { kind: 'unknown' } }), 100, 'approval-token');

  expect(formatted).toContain('Binding estimate (API-equivalent): unknown');
  expect(formatted).toContain('Source: unknown');
  expect(formatted).toContain('Freshness: unknown');
});

it.each([
  ['launch', noticeEvent({ kind: 'launch', reason: 'router_launch', previous: undefined,
    target: { providerId: 'launch-provider', modelId: 'launch-model' } }), /(?=.*launch)(?=.*router_launch)(?=.*launch-provider\/launch-model)/s],
  ['selector', noticeEvent({ kind: 'selector', reason: 'selector_timeout', previous: undefined, target: undefined }),
    /(?=.*selector)(?=.*selector_timeout)/s],
  ['exhausted', noticeEvent({ kind: 'exhausted', reason: 'fallback_exhausted', previous: undefined, target: undefined,
    lastAttempted: { providerId: 'last-provider', modelId: 'last-model' }, attemptedCount: 271, skippedCount: 143 }),
    /(?=.*exhausted)(?=.*fallback_exhausted)(?=.*last-provider\/last-model)(?=.*271)(?=.*143)/s],
  ['request completion', noticeEvent({ kind: 'request_completed', reason: 'request_completed', previous: undefined,
    target: { providerId: 'completed-provider', modelId: 'completed-model' } }),
    /(?=.*request_completed)(?=.*completed-provider\/completed-model)/s],
])('renders useful model references and outcome details for %s notices', (_kind, event, expectedContents) => {
  const formatted = evaluateNoticeFormat(event, 100, 'approval-token');

  expect(formatted).toMatch(expectedContents);
});

it.each([
  ['invalid target reference', noticeEvent({ target: { providerId: '', modelId: 'model' } }), 100],
  ['negative known estimate', noticeEvent({ estimate: { kind: 'known', amount: -1,
    snapshot: { source: 'price-fixture', freshness: 'current' } } }), 100],
  ['viewport too narrow for a readable notice', noticeEvent(), 20],
])('rejects %s without producing a truncated decision', (_caseName, event, columns) => {
  expect(() => evaluateNoticeFormat(event, columns, 'approval-token')).toThrow();
});

it('rejects content that cannot fit within the display limits', () => {
  const formatted = () => evaluateNoticeFormat(noticeEvent({
    reason: 'r'.repeat(1_200),
  }), 32, 'approval-token');

  expect(formatted).toThrow();
});
