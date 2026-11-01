import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createEvidenceStore } from '../../src/context/evidence-store.js';
import type { AnthropicMessage } from '../../src/context/anthropic-context-groups.js';
import type { SummaryEngine } from '../../src/context/summary-engine.js';
import type { StructuredSynopsis } from '../../src/context/summary-schema.js';

export function sourceMessages(): AnthropicMessage[] {
  return [
    { role: 'system', content: 'Follow the user instructions.' },
    { role: 'user', content: 'Keep this earlier user prose verbatim.' },
    { role: 'assistant', content: 'Keep this earlier assistant decision verbatim.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-old', name: 'search', input: { query: 'historical result' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-old', content: 'old result '.repeat(120) }] },
    { role: 'assistant', provider_metadata: { signature: 'opaque provider state' }, content: [{ type: 'tool_use', id: 'tool-provider', name: 'search', input: { query: 'provider-owned result' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-provider', content: 'Provider-owned result stays intact.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-recent', name: 'search', input: { query: 'recent result' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-recent', content: 'Recent result stays available.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-error', name: 'search', input: { query: 'failed lookup' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-error', is_error: true, content: 'The failed lookup error must stay visible.' }] },
    { role: 'assistant', content: 'Keep this latest assistant prose verbatim.' },
    { role: 'user', content: 'Keep this latest user prose verbatim.' },
  ];
}

export function synopsis(sourceId: string): StructuredSynopsis {
  const item = { text: 'The earlier tool lookup returned historical result.', sourceIds: [sourceId] };
  return {
    version: 1,
    taskGoal: 'Preserve the current request context.',
    userDecisions: [], constraints: [], verifiedFacts: [item], files: [], toolOutcomes: [],
    unresolved: [], failedApproaches: [], nextActions: [], chronology: [],
  };
}

export function fixtureEngine(run: SummaryEngine['summarize']): SummaryEngine {
  return { identity: 'fixture-summary-engine', billing: 'local', summarize: run };
}

export function paidEngine(run: SummaryEngine['summarize']): SummaryEngine {
  return { identity: 'fixture-paid-engine', billing: 'paid', summarize: run };
}

export function fixtureStore(home: string, key = randomBytes(32)) {
  return createEvidenceStore({ directory: join(home, 'evidence'), key, workspaceId: createHash('sha256').update(home).digest('hex') });
}

export function stageOptions() {
  return {
    workspaceId: 'fixture-workspace', sessionId: 'fixture-session', policyVersion: 'fixture-policy', generation: 'fixture-generation',
    maxInputTokens: 2_000, maxOutputTokens: 300, deadlineMs: 2_000, untouchedRecentTail: 1, rollingStride: 1,
  };
}
