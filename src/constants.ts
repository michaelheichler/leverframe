
import { homedir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import type { ModelFormat } from './types.js';

export const OPENAI_CHATGPT_PLAN_PROVIDER_ID = 'openai-chatgpt-plan';
export const OPENAI_CHATGPT_PLAN_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
export const ROUTING_ACTIVE_ENV = 'LEVERFRAME_ROUTING_ACTIVE';
export const ROUTING_ACTIVE_VALUE = '1';
export const ROUTING_NOTICE_ACTIVE_ENV = 'LEVERFRAME_ROUTING_NOTICE_ACTIVE';
export const ROUTING_PREPARE_ACTION = 'prepare';
export const ROUTING_LAUNCH_ACTION = 'launch';
export const ROUTING_CONTROL_BODY_LIMIT = 1024 * 1024;
export const ROUTING_PROMPT_POLICY_LIMIT = 128 * 1024;
export const ROUTING_HANDOFF_LIMIT = 96 * 1024;
export const ROUTING_SNAPSHOT_LABEL = 'LAUNCH SNAPSHOT. This is the original task and historical launch state. The existing transcript and latest instructions describe current state. Retain original constraints unless newer user instructions explicitly change them.\n';

export const CONFLICTING_ENV_VARS = [
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLOUD_ML_REGION',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;

export type ConflictingEnvVar = (typeof CONFLICTING_ENV_VARS)[number];

export const OPENCODE_CACHE_PATH = join(homedir(), '.cache', 'opencode', 'models.json');

export const MAX_MODEL_CATALOG = 20;

export const DEFAULT_SERVER_PORT = 17645;

export const VERTEX_ANTHROPIC_NPM = '@ai-sdk/google-vertex/anthropic';

export function classifyModelFormat(
  modelId: string,
  providerNpm: string | undefined,
): ModelFormat {
  if (providerNpm === '@ai-sdk/anthropic') return 'anthropic';
  if (providerNpm === '@ai-sdk/openai') return 'unsupported';
  if (providerNpm === '@ai-sdk/google') return 'unsupported';

  const lower = modelId.toLowerCase();
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gpt-')) return 'unsupported';
  if (lower.startsWith('gemini-')) return 'unsupported';

  return 'openai';
}

export const VERSION = pkg.version;
