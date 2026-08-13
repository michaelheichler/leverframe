// Fixture-only contract for the not-yet-implemented src/copilot/language-model.ts (Task 7).
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { vi } from 'vitest';

export interface CopilotSessionConfigLike {
  model?: string;
  reasoningEffort?: string;
  systemMessage?: { mode: 'replace'; content: string };
  availableTools?: string[];
  toolSearch?: { enabled: boolean };
  memory?: { enabled: boolean };
  infiniteSessions?: { enabled: boolean };
  enableSessionStore?: boolean;
  enableConfigDiscovery?: boolean;
  enableSkills?: boolean;
  skipCustomInstructions?: boolean;
  customAgentsLocalOnly?: boolean;
  pluginDirectories?: string[];
  mcpServers?: Record<string, unknown>;
  customAgents?: unknown[];
  onPermissionRequest?: unknown;
  workingDirectory?: string;
  cloud?: unknown;
  tools?: unknown[];
  sessionId?: string;
}

export type CopilotSessionEventLike =
  | { type: 'assistant.message_start'; data: { id: string } }
  | { type: 'assistant.message_delta'; data: { id: string; deltaContent: string } }
  | { type: 'assistant.message_end'; data: { id: string } }
  | { type: 'assistant.reasoning_delta'; data: { id: string; deltaContent: string } }
  | { type: 'assistant.tool_call'; data: { id: string; name: string; arguments: string } }
  | { type: 'assistant.turn_end'; data: Record<string, never> }
  | { type: 'session.error'; data: { message: string } };

export interface CopilotSessionLike {
  sessionId: string;
  send(options: {
    prompt: string;
    attachments?: Array<{ type: 'blob'; data: string; mimeType: string }>;
  }): Promise<string>;
  on(handler: (event: CopilotSessionEventLike) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotToolBridgeSettleReason {
  reason: 'abort' | 'disconnect' | 'timeout' | 'disposal';
}

export interface CopilotToolBridgeLike {
  copilotTools: unknown;
  pendingToolCallIds(): readonly string[];
  resolveToolResults(
    results: ReadonlyArray<{
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'text'; value: string };
    }>,
  ): void;
  settleAllPending(reason: CopilotToolBridgeSettleReason['reason']): void;
}

export interface CopilotRuntimeLike {
  start(): Promise<void>;
  createSession(
    config: CopilotSessionConfigLike,
    onEvent?: (event: CopilotSessionEventLike) => void,
  ): Promise<CopilotSessionLike>;
}

export interface CopilotSessionKeyInputLike {
  claudeSessionId: string;
  upstreamModel: string;
  reasoningEffort: string | null;
  systemPromptHash: string;
  toolSchemaHash: string;
}

export type TranscriptDecisionLike =
  | { kind: 'new-turn' }
  | { kind: 'exact-retry' }
  | { kind: 'tool-result-continuation'; resolvedToolCallIds: readonly string[] }
  | {
      kind: 'resync';
      reason: 'cold-restart' | 'model-changed' | 'tool-schema-changed' | 'system-prompt-changed' | 'rewind' | 'compaction' | 'branch';
    };

export interface CopilotConnectorDepsLike {
  readonly workingDirectory: string;
  getRuntime(): Promise<CopilotRuntimeLike>;
  createToolBridge(tools: readonly LanguageModelV3FunctionTool[]): CopilotToolBridgeLike;
  bridgeSessionEvents(events: AsyncIterable<CopilotSessionEventLike>): ReadableStream<LanguageModelV3StreamPart>;
  deriveSessionKey(input: CopilotSessionKeyInputLike): string;
  classifyTranscript(
    previous: unknown,
    current: unknown,
  ): TranscriptDecisionLike;
}

export interface CopilotLanguageModelConfigLike {
  modelId: string;
  providerId?: string;
}

export interface CopilotLanguageModelLike extends LanguageModelV3 {
  dispose(): Promise<void>;
}

export type CreateCopilotLanguageModel = (
  config: CopilotLanguageModelConfigLike,
  deps: CopilotConnectorDepsLike,
) => CopilotLanguageModelLike;

export interface CopilotLanguageModelModule {
  createCopilotLanguageModel: CreateCopilotLanguageModel;
  CopilotUnsupportedToolChoiceError: new (message: string) => Error;
}

// Computed (non-literal) specifier so TS cannot resolve it and fail typecheck on a missing module.
const CONNECTOR_MODULE_PATH = ['..', '..', 'src', 'copilot', 'language-model.js'].join('/');

export async function loadCopilotLanguageModelModule(): Promise<CopilotLanguageModelModule> {
  const mod: unknown = await import(CONNECTOR_MODULE_PATH);
  return mod as CopilotLanguageModelModule;
}

export function textPrompt(text: string, system?: string): LanguageModelV3Prompt {
  const messages: LanguageModelV3Prompt = [];
  if (system !== undefined) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: [{ type: 'text', text }] });
  return messages;
}

export function copilotProviderOptions(claudeSessionId: string, reasoningEffort?: string) {
  return { copilot: { claudeSessionId, ...(reasoningEffort ? { reasoningEffort } : {}) } };
}

export function callOptions(
  overrides: Partial<LanguageModelV3CallOptions> & { claudeSessionId: string; reasoningEffort?: string },
): LanguageModelV3CallOptions {
  const { claudeSessionId, reasoningEffort, ...rest } = overrides;
  return {
    prompt: textPrompt('hello'),
    providerOptions: copilotProviderOptions(claudeSessionId, reasoningEffort),
    ...rest,
  };
}

export function toolCallPrompt(toolCallId: string, toolName: string, input: string): LanguageModelV3Prompt {
  return [
    { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input }] },
  ];
}

export function toolResultPrompt(call: {
  toolCallId: string;
  toolName: string;
  input: string;
  result: string;
}): LanguageModelV3Prompt {
  return [
    ...toolCallPrompt(call.toolCallId, call.toolName, call.input),
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: 'text', value: call.result },
      }],
    },
  ];
}

export function createPendingToolBridge(): CopilotToolBridgeLike & {
  pendingPromises: Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void }>;
} {
  const pendingPromises = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void }>();
  return {
    copilotTools: [],
    pendingToolCallIds: vi.fn(() => [...pendingPromises.keys()]),
    resolveToolResults: vi.fn(
      (results: ReadonlyArray<{
        type: 'tool-result';
        toolCallId: string;
        toolName: string;
        output: { type: 'text'; value: string };
      }>) => {
        for (const entry of results) {
          pendingPromises.get(entry.toolCallId)?.resolve(entry.output.value);
          pendingPromises.delete(entry.toolCallId);
        }
      },
    ),
    settleAllPending: vi.fn(),
    pendingPromises,
  };
}

export function registerPendingToolCall(
  bridge: ReturnType<typeof createPendingToolBridge>,
  toolCallId: string,
): Promise<unknown> {
  const deferred = {} as { promise: Promise<unknown>; resolve: (value: unknown) => void };
  deferred.promise = new Promise(res => {
    deferred.resolve = res;
  });
  bridge.pendingPromises.set(toolCallId, deferred);
  return deferred.promise;
}

export function functionTool(name: string, description = 'a tool'): LanguageModelV3FunctionTool {
  return {
    type: 'function',
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}

export function createFakeSession(overrides: Partial<CopilotSessionLike> = {}): CopilotSessionLike & {
  emit: (event: CopilotSessionEventLike) => void;
  handlers: Array<(event: CopilotSessionEventLike) => void>;
} {
  const handlers: Array<(event: CopilotSessionEventLike) => void> = [];
  return {
    sessionId: 'session-fake-1',
    send: vi.fn(async () => 'message-1'),
    on: vi.fn((handler: (event: CopilotSessionEventLike) => void) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    }),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ...overrides,
    handlers,
    emit(event: CopilotSessionEventLike) {
      const snapshot = handlers.slice();
      for (const handler of snapshot) handler(event);
    },
  };
}

export function createFakeRuntime(session: CopilotSessionLike): CopilotRuntimeLike & {
  createSession: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(async () => {}),
    createSession: vi.fn(async (
      _config: CopilotSessionConfigLike,
      onEvent?: (event: CopilotSessionEventLike) => void,
    ) => {
      if (onEvent !== undefined) {
        session.on(onEvent);
        return {
          ...session,
          on: vi.fn((_handler: (event: CopilotSessionEventLike) => void) => () => undefined),
        };
      }
      return session;
    }),
  };
}

export function createFakeToolBridge(overrides: Partial<CopilotToolBridgeLike> = {}): CopilotToolBridgeLike {
  return {
    copilotTools: [],
    pendingToolCallIds: vi.fn(() => []),
    resolveToolResults: vi.fn(),
    settleAllPending: vi.fn(),
    ...overrides,
  };
}

export function readableStreamFromParts(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

export async function collectStreamParts(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const reader = stream.getReader();
  const parts: LanguageModelV3StreamPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

export interface BuildDepsOverrides {
  session?: CopilotSessionLike;
  runtime?: CopilotRuntimeLike;
  toolBridge?: CopilotToolBridgeLike;
  bridgeSessionEvents?: CopilotConnectorDepsLike['bridgeSessionEvents'];
  deriveSessionKey?: CopilotConnectorDepsLike['deriveSessionKey'];
  classifyTranscript?: CopilotConnectorDepsLike['classifyTranscript'];
}

export function buildDeps(overrides: BuildDepsOverrides = {}): {
  deps: CopilotConnectorDepsLike;
  session: CopilotSessionLike;
  runtime: ReturnType<typeof createFakeRuntime>;
  toolBridge: CopilotToolBridgeLike;
  getRuntimeSpy: ReturnType<typeof vi.fn>;
} {
  const session = overrides.session ?? createFakeSession();
  const runtime = (overrides.runtime as ReturnType<typeof createFakeRuntime>) ?? createFakeRuntime(session);
  const toolBridge = overrides.toolBridge ?? createFakeToolBridge();
  const getRuntimeSpy = vi.fn(async () => runtime);
  const deps: CopilotConnectorDepsLike = {
    workingDirectory: '/fixture/leverframe/copilot/workspace',
    getRuntime: getRuntimeSpy,
    createToolBridge: vi.fn(() => toolBridge),
    bridgeSessionEvents: overrides.bridgeSessionEvents ?? vi.fn(() => readableStreamFromParts([])),
    deriveSessionKey: overrides.deriveSessionKey
      ?? vi.fn((input: CopilotSessionKeyInputLike) => [
        'key',
        input.claudeSessionId,
        input.upstreamModel,
        input.reasoningEffort ?? 'none',
        input.systemPromptHash,
        input.toolSchemaHash,
      ].join(':')),
    classifyTranscript: overrides.classifyTranscript ?? vi.fn(() => ({ kind: 'new-turn' as const })),
  };
  return { deps, session, runtime, toolBridge, getRuntimeSpy };
}
