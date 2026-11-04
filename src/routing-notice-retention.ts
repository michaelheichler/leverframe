import type { RoutingBinding } from './routing-bindings.js';
import type { RoutingNotice } from './routing-fallback-contract.js';

export const MAX_RETAINED_ACKNOWLEDGED_NOTICES = 64;
export const MAX_RETAINED_ACKNOWLEDGED_BYTES = 64 * 1024;

export function compactRoutingNoticeHistory(state: { bindings: RoutingBinding[]; notices?: RoutingNotice[] }): void {
  for (const binding of state.bindings) {
    if (binding.lease === undefined && binding.pendingNotice?.acknowledged) delete binding.pendingNotice;
  }
  if (!state.notices?.length) return;
  const bindings = new Map(state.bindings.map(binding => [binding.modelId, binding]));
  for (const notice of state.notices) {
    if (!notice.acknowledged || !('kind' in notice) || (notice.kind !== 'launch' && notice.kind !== 'selector')) continue;
    const binding = bindings.get(notice.modelId);
    if (binding) (binding.initialNoticesAcknowledged ??= {})[notice.kind] = true;
  }
  let count = 0;
  let bytes = 0;
  const keep = new Set<RoutingNotice>();
  for (let index = state.notices.length - 1; index >= 0; index--) {
    const notice = state.notices[index]!;
    const binding = bindings.get(notice.modelId);
    if (!notice.acknowledged || binding?.lease || binding?.pendingNotice?.sequence === notice.sequence) {
      keep.add(notice);
      continue;
    }
    const size = Buffer.byteLength(JSON.stringify(notice), 'utf8');
    if (count < MAX_RETAINED_ACKNOWLEDGED_NOTICES && bytes + size <= MAX_RETAINED_ACKNOWLEDGED_BYTES) {
      keep.add(notice);
      count++;
      bytes += size;
    }
  }
  state.notices = state.notices.filter(notice => keep.has(notice));
}
