export const LOCAL_BENCHMARK_FIXTURE_ID = 'phase-0-context-contract-v1';

export interface BenchmarkFixtureContract {
  fixtureId: string;
  decisions: readonly string[];
  constraints: readonly string[];
  filePaths: readonly string[];
  unresolvedTasks: readonly string[];
  corrections: readonly string[];
  toolCalls: readonly {
    callId: string;
    tool: string;
    resultId: string;
  }[];
  chronology: readonly {
    order: number;
    eventId: string;
    kind: 'decision' | 'correction' | 'tool-call' | 'unresolved-task';
  }[];
}

export const PHASE_0_BENCHMARK_FIXTURE: BenchmarkFixtureContract = {
  fixtureId: LOCAL_BENCHMARK_FIXTURE_ID,
  decisions: ['decision-001', 'decision-002'],
  constraints: ['constraint-001', 'constraint-002'],
  filePaths: ['src/context/fixture-contract.ts', 'tests/fixture-contract.test.ts'],
  unresolvedTasks: ['task-001'],
  corrections: ['correction-001'],
  toolCalls: [
    { callId: 'call-001', tool: 'read-file', resultId: 'result-001' },
    { callId: 'call-002', tool: 'run-test', resultId: 'result-002' },
  ],
  chronology: [
    { order: 1, eventId: 'decision-001', kind: 'decision' },
    { order: 2, eventId: 'call-001', kind: 'tool-call' },
    { order: 3, eventId: 'correction-001', kind: 'correction' },
    { order: 4, eventId: 'call-002', kind: 'tool-call' },
    { order: 5, eventId: 'task-001', kind: 'unresolved-task' },
    { order: 6, eventId: 'decision-002', kind: 'decision' },
  ],
};