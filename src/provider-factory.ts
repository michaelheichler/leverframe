export {
  modelPrefersResponsesApi,
  shouldUseOpenAiResponsesEndpoint,
  isSdkMigratedNpm,
  maxToolsForNpm,
  EndpointUrlValidationError,
  createLanguageModel,
  type VertexProviderConfig,
  type ProviderModelSpec,
} from './language-model-factory.js';

export {
  getReasoningCapabilities,
  buildCodexReasoningLevels,
  effortProviderOptions,
  deepMergeProviderOptions,
  thinkingProviderOptions,
  type ReasoningMode,
  type ReasoningSource,
  type ReasoningConfidence,
  type ReasoningWireFormat,
  type ReasoningMetadata,
  type ReasoningCapabilities,
} from './reasoning-capability-detection.js';
