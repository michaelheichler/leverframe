// src/data/openai-oauth-models.ts
//
// Static seed list of GPT models accessible via ChatGPT Plus / Pro OAuth.
//
// WHY STATIC: The ChatGPT OAuth backend (chatgpt.com/backend-api/codex) does not
// expose a standard GET /v1/models endpoint. OAuth access tokens from auth.openai.com
// are NOT the same as developer API keys (sk-...) and are rejected by api.openai.com/v1/models.
// See provider-factory.ts: OpenAI OAuth routes inference to chatgpt.com/backend-api/codex,
// not api.openai.com.
//
// These are models confirmed to work via the ChatGPT Codex backend. Models are available
// depending on subscription tier (Plus vs Pro). We include the full set here and let the
// user discover what their tier unlocks at inference time.
//

import type { CachedModel } from '../registry/types.js';
import { deriveBrand } from '../models.js';

interface OAuthModelSeed {
  id: string;
  name: string;
  reasoning?: boolean;
  useResponsesLite?: boolean;
  preferWebSockets?: boolean;
}

export const CHATGPT_CODEX_UNSUPPORTED_MODELS = new Set<string>([
  'gpt-5.5-fast',   // confirmed: rejected by chatgpt.com/backend-api/codex
]);

const OPENAI_OAUTH_MODEL_SEEDS: OAuthModelSeed[] = [
  { id: 'gpt-5.6-sol',          name: 'GPT-5.6 Sol',       reasoning: true },
  { id: 'gpt-5.6-terra',        name: 'GPT-5.6 Terra',     reasoning: true },
  { id: 'gpt-5.6-luna',         name: 'GPT-5.6 Luna',      reasoning: true, useResponsesLite: true, preferWebSockets: true },
  { id: 'gpt-5.5',              name: 'GPT-5.5',           reasoning: true },
  { id: 'gpt-5.4',              name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini',         name: 'GPT-5.4 Mini' },
  { id: 'gpt-5',                name: 'GPT-5',             reasoning: true },
  { id: 'o4-mini',              name: 'o4 Mini',           reasoning: true },
  { id: 'o3',                   name: 'o3',                reasoning: true },
  { id: 'o3-mini',              name: 'o3 Mini',           reasoning: true },
  { id: 'o1',                   name: 'o1',                reasoning: true },
  { id: 'o1-mini',              name: 'o1 Mini',           reasoning: true },
];

export function buildOpenAiOAuthModels(): CachedModel[] {
  return OPENAI_OAUTH_MODEL_SEEDS.map(seed => {
    const prefix = seed.id.split('-')[0] ?? seed.id;
    return {
      id: seed.id,
      name: seed.name,
      upstreamModelId: seed.id,
      family: prefix,
      brand: deriveBrand(prefix),
      contextWindow: undefined,
      contextWindowUnconfirmed: true,
      modelFormat: 'openai' as const,
      npm: '@ai-sdk/openai',
      reasoning: seed.reasoning,
      useResponsesLite: seed.useResponsesLite,
      preferWebSockets: seed.preferWebSockets,
    };
  });
}
