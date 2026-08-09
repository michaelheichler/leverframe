export const TRUSTED_METADATA_VERSION = 1 as const;
export const TRUSTED_PROTOCOL_VERSION = '1' as const;

export const TRUSTED_METADATA_ENV = {
  workspaceId: 'LEVERFRAME_TRUSTED_WORKSPACE_ID_V1',
  capabilityToken: 'LEVERFRAME_TRUSTED_CAPABILITY_TOKEN_V1',
  agentRole: 'LEVERFRAME_TRUSTED_AGENT_ROLE_V1',
  parentSessionId: 'LEVERFRAME_TRUSTED_PARENT_SESSION_ID_V1',
  protocolVersion: 'LEVERFRAME_TRUSTED_PROTOCOL_VERSION_V1',
} as const;

export const TRUSTED_METADATA_HEADERS = {
  workspaceId: 'x-leverframe-trusted-workspace-id-v1',
  capabilityToken: 'x-leverframe-trusted-capability-token-v1',
  agentRole: 'x-leverframe-trusted-agent-role-v1',
  parentSessionId: 'x-leverframe-trusted-parent-session-id-v1',
  protocolVersion: 'x-leverframe-trusted-protocol-version-v1',
} as const;

const OPAQUE_WORKSPACE_ID = /^lfw1_[0-9a-f]{64}$/;
const CAPABILITY_TOKEN = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const AGENT_ROLES = ['main', 'subagent', 'worker', 'background'] as const;
const MAX_CANONICAL_PATH_LENGTH = 4096;

export type TrustedAgentRole = (typeof AGENT_ROLES)[number];

export interface TrustedMetadata {
  workspaceId: string;
  capabilityToken: string;
  agentRole: TrustedAgentRole;
  parentSessionId?: string;
  protocolVersion: typeof TRUSTED_PROTOCOL_VERSION;
}

export type TrustedMetadataHeaders = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validWorkspaceId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_WORKSPACE_ID.test(value);
}

function validCapabilityToken(value: unknown): value is string {
  return typeof value === 'string' && CAPABILITY_TOKEN.test(value);
}

function validAgentRole(value: unknown): value is TrustedAgentRole {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value);
}

function validParentSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function validateMetadata(value: unknown): TrustedMetadata {
  if (!isRecord(value)) throw new Error('trusted metadata must be an object');
  if (!validWorkspaceId(value.workspaceId)) throw new Error('trusted metadata workspace ID is invalid');
  if (!validCapabilityToken(value.capabilityToken)) throw new Error('trusted metadata capability token is invalid');
  if (!validAgentRole(value.agentRole)) throw new Error('trusted metadata agent role is invalid');
  if (value.parentSessionId !== undefined && !validParentSessionId(value.parentSessionId)) {
    throw new Error('trusted metadata parent session ID is invalid');
  }
  if (value.protocolVersion !== TRUSTED_PROTOCOL_VERSION) throw new Error('trusted metadata protocol version is invalid');
  return {
    workspaceId: value.workspaceId,
    capabilityToken: value.capabilityToken,
    agentRole: value.agentRole,
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
    protocolVersion: TRUSTED_PROTOCOL_VERSION,
  };
}

function metadataFields(metadata: TrustedMetadata): Record<string, string> {
  return {
    workspaceId: metadata.workspaceId,
    capabilityToken: metadata.capabilityToken,
    agentRole: metadata.agentRole,
    ...(metadata.parentSessionId === undefined ? {} : { parentSessionId: metadata.parentSessionId }),
    protocolVersion: metadata.protocolVersion,
  };
}

export function serializeTrustedMetadata(metadata: TrustedMetadata): {
  env: Record<string, string>;
  headers: TrustedMetadataHeaders;
} {
  const valid = validateMetadata(metadata);
  const fields = metadataFields(valid);
  const env: Record<string, string> = {};
  const headers: TrustedMetadataHeaders = {};
  for (const field of Object.keys(fields) as Array<keyof typeof TRUSTED_METADATA_ENV>) {
    env[TRUSTED_METADATA_ENV[field]] = fields[field];
    headers[TRUSTED_METADATA_HEADERS[field]] = fields[field];
  }
  return { env, headers };
}

function parseFields(fields: Record<string, unknown>): TrustedMetadata {
  const allowed = new Set(['workspaceId', 'capabilityToken', 'agentRole', 'parentSessionId', 'protocolVersion']);
  if (Object.keys(fields).some(key => !allowed.has(key))) throw new Error('trusted metadata contains an unknown field');
  return validateMetadata({
    workspaceId: fields.workspaceId,
    capabilityToken: fields.capabilityToken,
    agentRole: fields.agentRole,
    parentSessionId: fields.parentSessionId,
    protocolVersion: fields.protocolVersion,
  });
}

export function parseTrustedMetadataEnv(env: Record<string, string | undefined>): TrustedMetadata {
  const allowed = new Set<string>(Object.values(TRUSTED_METADATA_ENV));
  if (Object.keys(env).some(key => !allowed.has(key))) throw new Error('trusted metadata environment contains an unknown variable');
  return parseFields({
    workspaceId: env[TRUSTED_METADATA_ENV.workspaceId],
    capabilityToken: env[TRUSTED_METADATA_ENV.capabilityToken],
    agentRole: env[TRUSTED_METADATA_ENV.agentRole],
    parentSessionId: env[TRUSTED_METADATA_ENV.parentSessionId],
    protocolVersion: env[TRUSTED_METADATA_ENV.protocolVersion],
  });
}

export function parseTrustedMetadataHeaders(headers: Record<string, string | undefined>): TrustedMetadata {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const allowed = new Set<string>(Object.values(TRUSTED_METADATA_HEADERS));
  if (Object.keys(normalized).some(key => !allowed.has(key))) throw new Error('trusted metadata headers contain an unknown header');
  return parseFields({
    workspaceId: normalized[TRUSTED_METADATA_HEADERS.workspaceId],
    capabilityToken: normalized[TRUSTED_METADATA_HEADERS.capabilityToken],
    agentRole: normalized[TRUSTED_METADATA_HEADERS.agentRole],
    parentSessionId: normalized[TRUSTED_METADATA_HEADERS.parentSessionId],
    protocolVersion: normalized[TRUSTED_METADATA_HEADERS.protocolVersion],
  });
}

export function assertCanonicalWorkspacePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_CANONICAL_PATH_LENGTH) {
    throw new Error('canonical workspace path is invalid');
  }
}

export { verifyCapabilityToken } from './trusted-crypto.js';