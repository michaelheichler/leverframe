/**
 * Wires the custom V3 connector to the optional public Copilot SDK boundary.
 * Runtime creation stays lazy, so unrelated providers do not load or require the SDK.
 */

import type { LanguageModelV3FunctionTool, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { ToolResultPart } from 'ai';
import { bridgeCopilotSessionEvents } from './event-readable-stream.js';
import { createMemorySessionFsProvider } from './memory-session-fs.js';
import type { CopilotSessionEvent } from './event-stream.js';
import {
  createCopilotLanguageModel,
  type CopilotLanguageModel,
  type CopilotLanguageModelDependencies,
  type CopilotLanguageRuntime,
  type CopilotLanguageToolBridge,
  type CopilotSessionConfig,
} from './language-model.js';
import {
  createDefaultCopilotRuntime,
  resolveCopilotDirectories,
  type CopilotRuntimeHandle,
} from './runtime.js';
import { createToolBridge, type ToolBridge } from './tool-bridge.js';
import { classifyTranscript, deriveCopilotSessionKey } from './transcript.js';

interface RuntimeSessionClient {
  sessionId: string;
  send(options: { prompt: string }): Promise<string>;
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

function runtimeAdapter(runtime: CopilotRuntimeHandle): CopilotLanguageRuntime {
  return {
    start: () => runtime.start(),
    async createSession(config: CopilotSessionConfig, onEvent: (event: unknown) => void) {
      return await runtime.createSession({
        ...config,
        onEvent,
        createSessionFsProvider: createMemorySessionFsProvider,
      }) as RuntimeSessionClient;
    },
  };
}

function toolBridgeAdapter(bridge: ToolBridge): CopilotLanguageToolBridge {
  return {
    copilotTools: bridge.copilotTools,
    pendingToolCallIds: () => bridge.pendingToolCallIds(),
    resolveToolResults: results => bridge.resolveToolResults(results as readonly ToolResultPart[]),
    settleAllPending: reason => bridge.settleAllPending(reason),
  };
}

function connectorDependencies(input: {
  gitHubToken: string;
  environment: NodeJS.ProcessEnv;
  nodeVersion: string;
}): CopilotLanguageModelDependencies {
  const directories = resolveCopilotDirectories(input.environment);
  let runtime: CopilotRuntimeHandle | undefined;
  return {
    workingDirectory: directories.workingDirectory,
    async getRuntime() {
      runtime ??= createDefaultCopilotRuntime({
        gitHubToken: input.gitHubToken,
        nodeVersion: input.nodeVersion,
        environment: input.environment,
      });
      return runtimeAdapter(runtime);
    },
    createToolBridge(tools: readonly LanguageModelV3FunctionTool[]) {
      return toolBridgeAdapter(createToolBridge(tools));
    },
    bridgeSessionEvents(events: AsyncIterable<unknown>): ReadableStream<LanguageModelV3StreamPart> {
      return bridgeCopilotSessionEvents(events as AsyncIterable<CopilotSessionEvent>);
    },
    deriveSessionKey: deriveCopilotSessionKey,
    classifyTranscript,
  };
}

/** Creates the production connector without starting the SDK runtime. */
export function createDefaultCopilotLanguageModel(input: {
  modelId: string;
  gitHubToken: string;
  environment: NodeJS.ProcessEnv;
  nodeVersion: string;
}): CopilotLanguageModel {
  if (input.gitHubToken.length === 0) {
    throw new TypeError('GitHub Copilot credential is empty. Run leverframe providers auth github-copilot');
  }
  return createCopilotLanguageModel(
    { modelId: input.modelId },
    connectorDependencies(input),
  );
}
