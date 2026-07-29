// src/executions-command.ts — `leverframe executions` CLI (stabilization
// plan §8.3): local inspection and the reconciliation entry point for
// ambiguous tool calls. Deliberately bypasses the main ParsedArgs pipeline
// (see src/cli.ts) since it is a small, self-contained subcommand group.

import { getExecutionDetail, listExecutionSummaries, type ExecutionStatus } from './execution-query.js';
import type { ReconcileOutcome } from './execution-recovery.js';
import { reconcileToolCallWorkflow } from './reconcile-tool-call-workflow.js';

function printUsage(): void {
  console.log(`Usage: leverframe executions <list|show|reconcile>

  leverframe executions list
  leverframe executions show <scope-hash> <execution-id>
  leverframe executions reconcile <scope-hash> <execution-id> --tool-call <id> --executed|--not-executed
  leverframe executions reconcile <scope-hash> <execution-id> --all --executed|--not-executed`);
}

function renderExecutionStatus(status: ExecutionStatus): string {
  switch (status.kind) {
    case 'recovery': return status.decision;
    case 'storage': return `storage:${status.state}`;
  }
}

function runList(): number {
  const summaries = listExecutionSummaries();
  if (summaries.length === 0) {
    console.log('No executions found.');
    return 0;
  }
  for (const summary of summaries) {
    console.log(`${summary.scopeHash}/${summary.executionId}  provider=${summary.provider ?? '?'} model=${summary.model ?? '?'} status=${renderExecutionStatus(summary.status)} ambiguousToolCalls=${summary.ambiguousToolCalls}`);
  }
  return 0;
}

function runShow(rest: string[]): number {
  const [scopeHash, executionId] = rest;
  if (!scopeHash || !executionId) {
    printUsage();
    return 1;
  }
  const detail = getExecutionDetail(scopeHash, executionId);
  console.log(JSON.stringify(detail, null, 2));
  return detail.found ? 0 : 1;
}

interface ReconcileFlags {
  toolCallId?: string;
  all: boolean;
  outcome?: ReconcileOutcome;
}

function parseReconcileFlags(flags: string[]): ReconcileFlags {
  const toolCallIndex = flags.indexOf('--tool-call');
  return {
    toolCallId: toolCallIndex >= 0 ? flags[toolCallIndex + 1] : undefined,
    all: flags.includes('--all'),
    outcome: flags.includes('--executed') ? 'executed' : flags.includes('--not-executed') ? 'not-executed' : undefined,
  };
}

function runReconcile(rest: string[]): number {
  const [scopeHash, executionId, ...flags] = rest;
  if (!scopeHash || !executionId) {
    printUsage();
    return 1;
  }
  const { toolCallId, all, outcome } = parseReconcileFlags(flags);
  if (!outcome || (!toolCallId && !all)) {
    console.error('Specify --executed or --not-executed, and either --tool-call <id> or --all.');
    printUsage();
    return 1;
  }

  const workflow = reconcileToolCallWorkflow({
    scopeHash,
    executionId,
    selection: all ? { kind: 'all' } : { kind: 'one', toolCallId: toolCallId ?? '' },
    outcome,
  });
  if (!workflow.ok && workflow.results.length === 0) {
    console.error(`Reconciliation failed: ${workflow.error ?? 'unknown error'}`);
    return 1;
  }
  if (workflow.results.length === 0) {
    console.log('No ambiguous tool calls to reconcile.');
    return 0;
  }
  for (const result of workflow.results) {
    console.log(result.ok
      ? `reconciled ${result.entry?.toolCallId} -> ${result.entry?.status} (generation ${result.generation})`
      : `failed: ${result.error}`);
  }
  return workflow.ok ? 0 : 1;
}

export async function runExecutionsCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return 0;
  }
  if (sub === 'list') return runList();
  if (sub === 'show') return runShow(rest);
  if (sub === 'reconcile') return runReconcile(rest);
  printUsage();
  return 1;
}
