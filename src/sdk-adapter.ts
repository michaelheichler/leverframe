// Anthropic /v1/messages ↔ Vercel AI SDK. One turn per request. Claude Code owns the tool loop.
// Orchestration entry point: re-exports the public surface assembled from the
// request-translation, usage-extraction, streaming-response, and
// non-streaming-response modules below.
import { silenceSdkWarnings } from './proxy-shared.js';

export { silenceSdkWarnings };

export {
  ToolResultImageError,
  type AnthropicRequest,
  type TranslateRequestOptions,
  type SdkCallParams,
  type ToolInputRules,
  extractClaudeSessionId,
  claudeSessionPromptCacheKey,
  anthropicEffortFromRequest,
  openAiPromptCacheKey,
  supportsOpenAiPromptCacheBreakpoints,
  annotateToolNames,
  translateMessages,
  sanitizeToolInput,
  toolInputRules,
  translateTools,
  translateToolChoice,
  translateRequest,
} from './sdk-request-translation.js';

export {
  type AnthropicUsage,
  type AnthropicUsageTrace,
  toAnthropicUsage,
  sdkPromptCacheKeyHash,
} from './sdk-usage.js';

export {
  type SdkTranslationErrorSignature,
  sdkTranslationErrorSignature,
  type AnthropicStreamObserver,
  positiveEnvMs,
  writeAnthropicStream,
  streamAnthropicResponse,
} from './sdk-streaming-response.js';

export { generateAnthropicResponse } from './sdk-non-streaming-response.js';
