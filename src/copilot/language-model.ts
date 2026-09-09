

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { collectCopilotGenerateResult } from './generate-result.js';
import { comparisonWithResponse } from './response-history.js';
import { createSessionEventSource } from './session-events.js';
import { renderCopilotHistory } from './serialized-history.js';
import type {
  TranscriptComparisonState,
  TranscriptDecision,
} from './transcript.js';
import { copilotMessage, v3ImageAttachments, v3LatestUserImageAttachments } from './message.js';
import {
  v3ComparisonState,
  v3LatestUserPrompt,
  v3SystemPrompt,
  v3ToolResults,
} from './prompt.js';
import {
  recordCopilotResponse,
  replayCopilotResponse,
} from './response-replay.js';
import {
  COPILOT_REASONING_EFFORT_SET,
  type CopilotReasoningEffort,
} from './reasoning-effort.js';

export interface CopilotSessionConfig {
  model: string;
  reasoningEffort?: string;
  systemMessage: { mode: 'replace'; content: string };
  availableTools: string[];
  tools: unknown[];
  toolSearch: { enabled: false };
  memory: { enabled: false };
  infiniteSessions: { enabled: false };
  enableSessionStore: false;
  enableConfigDiscovery: false;
  enableSkills: false;
  skipCustomInstructions: true;
  customAgentsLocalOnly: true;
  workingDirectory: string;
}

export interface CopilotLanguageSession {
  sessionId: string;
  send(options: { prompt: string }): Promise<string>;
  on(handler: (event: unknown) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotLanguageRuntime {
  start(): Promise<void>;
  createSession(
    config: CopilotSessionConfig,
    onEvent: (event: unknown) => void,
  ): Promise<CopilotLanguageSession>;
}

export interface CopilotLanguageToolBridge {
  readonly copilotTools: readonly unknown[];
  pendingToolCallIds(): readonly string[];
  resolveToolResults(results: readonly unknown[]): void;
  settleAllPending(reason: 'abort' | 'disconnect' | 'timeout' | 'disposal'): void;
}

export interface CopilotLanguageModelDependencies {
  readonly workingDirectory: string;
  getRuntime(): Promise<CopilotLanguageRuntime>;
  dispose?(): Promise<void>;
  createToolBridge(tools: readonly LanguageModelV3FunctionTool[]): CopilotLanguageToolBridge;
  bridgeSessionEvents(events: AsyncIterable<unknown>): ReadableStream<LanguageModelV3StreamPart>;
  deriveSessionKey(input: {
    claudeSessionId: string;
    upstreamModel: string;
    reasoningEffort: string | null;
    systemPromptHash: string;
    toolSchemaHash: string;
  }): string;
  classifyTranscript(
    previous: TranscriptComparisonState | null,
    current: TranscriptComparisonState,
  ): TranscriptDecision;
}

export interface CopilotLanguageModel extends LanguageModelV3 {
  dispose(): Promise<void>;
}

export interface CopilotLanguageModelConfig {
  modelId: string;
  providerId?: string;
}

interface SessionState {
  key: string;
  session: CopilotLanguageSession;
  toolBridge: CopilotLanguageToolBridge;
  comparison: TranscriptComparisonState;
  subscribeEvents(handler: (event: unknown) => void): () => void;
  turnAbort?: AbortController;
  requestComparison?: TranscriptComparisonState;
  completedResponse?: readonly LanguageModelV3StreamPart[];
}

interface RequestContext {
  options: LanguageModelV3CallOptions;
  partitionId: string;
  tools: LanguageModelV3FunctionTool[];
  comparison: TranscriptComparisonState;
  key: string;
  toolChoice: 'auto' | 'none';
}

export class CopilotUnsupportedToolChoiceError extends Error {
  constructor(toolChoice: string) {
    super(`GitHub Copilot does not support tool choice "${toolChoice}". Use "auto" or "none".`);
    this.name = 'CopilotUnsupportedToolChoiceError';
  }
}

function providerOption(
  options: LanguageModelV3CallOptions,
  field: string,
): unknown {
  return options.providerOptions?.copilot?.[field];
}

const CLAUDE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIdentity(options: LanguageModelV3CallOptions): {
  claudeSessionId: string;
  reasoningEffort: CopilotReasoningEffort | null;
} {
  const claudeSessionId = providerOption(options, 'claudeSessionId');
  const effort = providerOption(options, 'reasoningEffort');
  if (typeof claudeSessionId !== 'string' || !CLAUDE_SESSION_ID_RE.test(claudeSessionId)) {
    throw new TypeError('GitHub Copilot requires a validated Claude session ID');
  }
  if (effort !== undefined && (
    typeof effort !== 'string' || !COPILOT_REASONING_EFFORT_SET.has(effort as CopilotReasoningEffort)
  )) {
    throw new TypeError('GitHub Copilot reasoning effort must be low, medium, high, xhigh, or max');
  }
  return { claudeSessionId, reasoningEffort: effort as CopilotReasoningEffort | undefined ?? null };
}

function functionTools(options: LanguageModelV3CallOptions): LanguageModelV3FunctionTool[] {
  const tools = options.tools ?? [];
  const providerTool = tools.find(tool => tool.type === 'provider');
  if (providerTool !== undefined) {
    throw new TypeError(`GitHub Copilot does not accept provider tool "${providerTool.name}"`);
  }
  return tools as LanguageModelV3FunctionTool[];
}

function validateToolChoice(options: LanguageModelV3CallOptions): 'auto' | 'none' {
  const choice = options.toolChoice?.type ?? 'auto';
  if (choice === 'auto' || choice === 'none') return choice;
  throw new CopilotUnsupportedToolChoiceError(choice);
}

function requestContext(input: {
  options: LanguageModelV3CallOptions;
  config: CopilotLanguageModelConfig;
  deps: CopilotLanguageModelDependencies;
}): RequestContext {
  const toolChoice = validateToolChoice(input.options);
  const identity = requestIdentity(input.options);
  const tools = functionTools(input.options);
  const availableTools = toolChoice === 'none' ? [] : tools;
  const comparison = v3ComparisonState({
    prompt: input.options.prompt,
    modelId: input.config.modelId,
    reasoningEffort: identity.reasoningEffort,
    tools: availableTools,
  });
  const key = input.deps.deriveSessionKey({
    claudeSessionId: identity.claudeSessionId,
    upstreamModel: input.config.modelId,
    reasoningEffort: identity.reasoningEffort,
    systemPromptHash: comparison.systemPromptHash,
    toolSchemaHash: comparison.toolSchemaHash,
  });
  return {
    options: input.options,
    partitionId: identity.claudeSessionId,
    tools,
    comparison,
    key,
    toolChoice,
  };
}

function sessionConfig(input: {
  modelId: string;
  reasoningEffort: string | null;
  systemPrompt: string;
  tools: readonly LanguageModelV3FunctionTool[];
  copilotTools: readonly unknown[];
  toolChoice: 'auto' | 'none';
  workingDirectory: string;
}): CopilotSessionConfig {
  const enabledTools = input.toolChoice === 'none' ? [] : input.tools;
  return {
    model: input.modelId,
    ...(input.reasoningEffort === null ? {} : { reasoningEffort: input.reasoningEffort }),
    systemMessage: { mode: 'replace', content: input.systemPrompt },
    availableTools: enabledTools.map(tool => tool.name),
    tools: input.toolChoice === 'none' ? [] : [...input.copilotTools],
    toolSearch: { enabled: false },
    memory: { enabled: false },
    infiniteSessions: { enabled: false },
    enableSessionStore: false,
    enableConfigDiscovery: false,
    enableSkills: false,
    skipCustomInstructions: true,
    customAgentsLocalOnly: true,
    workingDirectory: input.workingDirectory,
  };
}

function wrapAbort(input: {
  stream: ReadableStream<LanguageModelV3StreamPart>;
  signal: AbortSignal | undefined;
  session: CopilotLanguageSession;
  toolBridge: CopilotLanguageToolBridge;
  source: { close(): void };
}): ReadableStream<LanguageModelV3StreamPart> {
  const reader = input.stream.getReader();
  let settled = false;
  let abortListener: () => void;
  const cleanup = () => {
    settled = true;
    input.signal?.removeEventListener('abort', abortListener);
    input.source.close();
  };
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: unknown): Promise<void> => {
    if (cancellation !== undefined) return cancellation;
    if (settled) return Promise.resolve();
    cleanup();
    input.toolBridge.settleAllPending('abort');
    cancellation = Promise.all([input.session.abort(), reader.cancel(reason)]).then(() => {});
    return cancellation;
  };
  return new ReadableStream({
    start(controller) {
      abortListener = () => {
        const error = new Error('GitHub Copilot request aborted');
        void cancel(error).then(
          () => controller.error(error),
          failure => controller.error(failure),
        );
      };
      input.signal?.addEventListener('abort', abortListener, { once: true });
      if (input.signal?.aborted) abortListener();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (settled) return;
        if (next.done) { cleanup(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (settled) return;
        cleanup();
        controller.error(error);
      }
    },
    cancel,
  });
}

async function startTurn(input: {
  active: SessionState;
  deps: CopilotLanguageModelDependencies;
  context: RequestContext;
  decision: TranscriptDecision;
  recreating: boolean;
}): Promise<ReadableStream<LanguageModelV3StreamPart>> {
  const source = createSessionEventSource<unknown>({
    subscribe: handler => input.active.subscribeEvents(handler),
  });
  const turnAbort = new AbortController();
  input.active.turnAbort = turnAbort;
  const signal = input.context.options.abortSignal;
  const stream = wrapAbort({
    stream: input.deps.bridgeSessionEvents(source),
    signal: signal === undefined ? turnAbort.signal : AbortSignal.any([signal, turnAbort.signal]),
    session: input.active.session,
    toolBridge: input.active.toolBridge,
    source,
  });
  try {
    if (input.decision.kind === 'tool-result-continuation' && !input.recreating) {
      const ids = new Set(input.decision.resolvedToolCallIds);
      input.active.toolBridge.resolveToolResults(v3ToolResults(input.context.options.prompt)
        .filter(result => ids.has(result.toolCallId)));
    } else if (input.decision.kind !== 'exact-retry' || input.recreating) {
      const fullHistory = input.recreating || (input.decision.kind === 'resync'
        && input.context.comparison.history.entries.length > 1);
      const promptText = fullHistory
        ? renderCopilotHistory(input.context.options.prompt)
        : v3LatestUserPrompt(input.context.options.prompt);
      const attachments = fullHistory
        ? v3ImageAttachments(input.context.options.prompt)
        : v3LatestUserImageAttachments(input.context.options.prompt);
      await input.active.session.send(copilotMessage(promptText, attachments));
    }
    return stream;
  } catch (error) {
    await stream.cancel(error).catch(() => {});
    throw error;
  }
}

function withComparison(
  state: SessionState,
  comparison: TranscriptComparisonState,
): SessionState {
  return { ...state, comparison, requestComparison: comparison, completedResponse: undefined };
}

function streamResult(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): LanguageModelV3StreamResult {
  return { stream, request: { body: undefined }, response: undefined };
}

function resolveSlotKey(input: {
  sessions: ReadonlyMap<string, SessionState>;
  activeResponses: ReadonlySet<string>;
  context: RequestContext;
}): string {
  const primary = input.sessions.get(input.context.partitionId);
  const primaryBusy = input.activeResponses.has(input.context.partitionId);
  const sharesPrimarySlot = primary === undefined || primary.key === input.context.key;
  return primaryBusy && !sharesPrimarySlot
    ? `${input.context.partitionId}\x1f${input.context.key}`
    : input.context.partitionId;
}

type TurnResolution =
  | { kind: 'replay'; parts: readonly LanguageModelV3StreamPart[] }
  | { kind: 'turn'; active: SessionState; decision: TranscriptDecision; recreating: boolean };

async function resolveTurnSession(input: {
  slotKey: string;
  key: string;
  comparison: TranscriptComparisonState;
  options: LanguageModelV3CallOptions;
  context: RequestContext;
  sessions: Map<string, SessionState>;
  createState: (input: {
    options: LanguageModelV3CallOptions;
    key: string;
    comparison: TranscriptComparisonState;
    tools: LanguageModelV3FunctionTool[];
    toolChoice: 'auto' | 'none';
  }) => Promise<SessionState>;
  deps: CopilotLanguageModelDependencies;
}): Promise<TurnResolution> {
  const previous = input.sessions.get(input.slotKey);
  const decision = previous === undefined
    ? { kind: 'resync', reason: 'cold-restart' } as const
    : input.deps.classifyTranscript(previous.comparison, input.comparison);
  const retry = previous?.requestComparison !== undefined
    && input.deps.classifyTranscript(previous.requestComparison, input.comparison).kind === 'exact-retry';
  const replay = retry && previous?.key === input.key ? previous.completedResponse : undefined;
  if (replay !== undefined) return { kind: 'replay', parts: replay };
  const missingRetryReplay = decision.kind === 'exact-retry';
  const recreating = previous !== undefined
    && (previous.key !== input.key || decision.kind === 'resync' || missingRetryReplay);
  let active = previous;
  if (previous === undefined || recreating) {
    if (previous !== undefined) {
      previous.toolBridge.settleAllPending('disconnect');
      await previous.session.disconnect();
    }
    active = await input.createState({
      options: input.options,
      key: input.key,
      comparison: input.comparison,
      tools: input.context.tools,
      toolChoice: input.context.toolChoice,
    });
    input.sessions.set(input.slotKey, active);
  }
  if (active === undefined) throw new Error('Copilot session state was not created');
  return { kind: 'turn', active, decision, recreating };
}

export function createCopilotLanguageModel(
  config: CopilotLanguageModelConfig,
  deps: CopilotLanguageModelDependencies,
): CopilotLanguageModel {
  const sessions = new Map<string, SessionState>();
  const activeResponses = new Set<string>();
  const pendingStarts = new Set<Promise<TurnResolution>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const createState = async (input: {
    options: LanguageModelV3CallOptions;
    key: string;
    comparison: TranscriptComparisonState;
    tools: LanguageModelV3FunctionTool[];
    toolChoice: 'auto' | 'none';
  }): Promise<SessionState> => {
    const runtime = await deps.getRuntime();
    await runtime.start();
    if (disposed) throw new Error('GitHub Copilot model has been disposed');
    if (input.options.abortSignal?.aborted) throw new Error('GitHub Copilot request aborted');
    const toolBridge = deps.createToolBridge(input.toolChoice === 'none' ? [] : input.tools);
    const earlyEvents: unknown[] = [];
    let sessionEventHandler: ((event: unknown) => void) | undefined;
    const session = await runtime.createSession(sessionConfig({
      modelId: config.modelId,
      reasoningEffort: input.comparison.reasoningEffort,
      systemPrompt: v3SystemPrompt(input.options.prompt),
      tools: input.tools,
      copilotTools: toolBridge.copilotTools,
      toolChoice: input.toolChoice,
      workingDirectory: deps.workingDirectory,
    }), event => {
      if (sessionEventHandler === undefined) earlyEvents.push(event);
      else sessionEventHandler(event);
    });
    if (disposed || input.options.abortSignal?.aborted) {
      toolBridge.settleAllPending(disposed ? 'disposal' : 'abort');
      await session.disconnect();
      throw new Error(disposed ? 'GitHub Copilot model has been disposed' : 'GitHub Copilot request aborted');
    }
    return {
      key: input.key,
      session,
      toolBridge,
      comparison: input.comparison,
      subscribeEvents(handler) {
        sessionEventHandler = handler;
        for (const event of earlyEvents.splice(0)) handler(event);
        return () => { sessionEventHandler = undefined; };
      },
    };
  };

  const doStream = async (options: LanguageModelV3CallOptions) => {
    if (disposed) throw new Error('GitHub Copilot model has been disposed');
    if (options.abortSignal?.aborted) throw new Error('GitHub Copilot request aborted');
    const context = requestContext({ options, config, deps });
    const slotKey = resolveSlotKey({ sessions, activeResponses, context });
    if (activeResponses.has(slotKey)) {
      throw new Error('A GitHub Copilot response is already active for this Claude session');
    }
    activeResponses.add(slotKey);
    const { comparison, key } = context;
    const pending = resolveTurnSession({
      slotKey, key, comparison, options, context, sessions, createState, deps,
    });
    pendingStarts.add(pending);
    try {
      const resolved = await pending;
      if (disposed) throw new Error('GitHub Copilot model has been disposed');
      if (options.abortSignal?.aborted) throw new Error('GitHub Copilot request aborted');
      if (resolved.kind === 'replay') {
        activeResponses.delete(slotKey);
        return streamResult(replayCopilotResponse(resolved.parts));
      }
      const { active, decision, recreating } = resolved;
      const stream = await startTurn({ active, deps, context, decision, recreating });
      if (disposed || options.abortSignal?.aborted) {
        await stream.cancel().catch(() => {});
        throw new Error(disposed ? 'GitHub Copilot model has been disposed' : 'GitHub Copilot request aborted');
      }
      sessions.set(slotKey, withComparison(active, comparison));
      const recorded = recordCopilotResponse({
        stream,
        onComplete(parts) {
          const latest = sessions.get(slotKey);
          if (latest?.key === key && latest.comparison === comparison) {
            sessions.set(slotKey, { ...latest, requestComparison: comparison,
              comparison: comparisonWithResponse(comparison, parts), completedResponse: parts });
          }
        },
        onSettled() {
          activeResponses.delete(slotKey);
        },
      });
      return streamResult(recorded);
    } catch (error) {
      activeResponses.delete(slotKey);
      throw error;
    } finally {
      pendingStarts.delete(pending);
    }
  };

  const model: CopilotLanguageModel = {
    specificationVersion: 'v3',
    provider: config.providerId ?? 'github-copilot',
    modelId: config.modelId,
    supportedUrls: {},
    doStream,
    async doGenerate(options) {
      return collectCopilotGenerateResult((await doStream(options)).stream);
    },
    async dispose() {
      if (disposal !== undefined) return disposal;
      disposed = true;
      disposal = (async () => {
        await Promise.allSettled(pendingStarts);
        const active = [...sessions.values()];
        sessions.clear();
        activeResponses.clear();
        for (const state of active) {
          state.toolBridge.settleAllPending('disposal');
          state.turnAbort?.abort();
        }
        try { await Promise.all(active.map(state => state.session.disconnect())); }
        finally { await deps.dispose?.(); }
      })();
      return disposal;
    },
  };
  return model;
}
