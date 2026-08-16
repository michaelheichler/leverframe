import type { ModelAlias } from './types.js';
import { stripOneMContextSuffix } from './context-model-id.js';

const MODEL_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class InvalidModelAliasError extends Error {
  constructor(name: string) {
    super(`Invalid model alias "${name}": names must be 1-64 letters, numbers, dots, underscores, or hyphens.`);
    this.name = 'InvalidModelAliasError';
  }
}

export class InvalidModelAliasConfigurationError extends Error {
  constructor(detail: string) {
    super(`Invalid model alias configuration: ${detail}. Fix modelAliases in config.json, then re-run.`);
    this.name = 'InvalidModelAliasConfigurationError';
  }
}

export class ModelAliasCollisionError extends Error {
  constructor(name: string, first: ModelAlias, second: ModelAlias) {
    super(
      `Model aliases "${first.name}" and "${second.name}" both normalize to "${name}" `
        + `but target ${modelAliasTarget(first)} and ${modelAliasTarget(second)}. `
        + 'Rename or remove one alias, then re-run.',
    );
    this.name = 'ModelAliasCollisionError';
  }
}

export function isValidModelAlias(name: string): boolean {
  return MODEL_ALIAS_PATTERN.test(name);
}

export function canonicalizeModelAliasName(name: string): string | null {
  const trimmed = name.trim();
  return isValidModelAlias(trimmed) ? trimmed.toLowerCase() : null;
}

export function normalizeModelAliases(aliases: unknown): ModelAlias[] {
  if (!Array.isArray(aliases)) {
    throw new InvalidModelAliasConfigurationError('modelAliases must be an array');
  }
  const seen = new Map<string, ModelAlias>();
  return aliases.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidModelAliasConfigurationError(`entry ${index + 1} must be an object`);
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate['name'] !== 'string'
      || typeof candidate['providerId'] !== 'string'
      || typeof candidate['modelId'] !== 'string'
    ) {
      throw new InvalidModelAliasConfigurationError(
        `entry ${index + 1} requires string name, providerId, and modelId fields`,
      );
    }
    const alias: ModelAlias = {
      name: candidate['name'],
      providerId: candidate['providerId'],
      modelId: candidate['modelId'],
    };
    const name = canonicalizeModelAliasName(alias.name);
    if (name === null) throw new InvalidModelAliasError(alias.name);
    const normalized = { ...alias, name };
    const existing = seen.get(name);
    if (existing) throw new ModelAliasCollisionError(name, existing, alias);
    seen.set(name, normalized);
    return normalized;
  });
}

/** Parse `luna=leverframe:openai-oauth:gpt-5.6-luna` (the `leverframe:` prefix is optional). */
export function parseModelAliasAssignment(value: string): ModelAlias | { error: string } {
  const separator = value.indexOf('=');
  if (separator < 1 || separator === value.length - 1) {
    return { error: 'Alias must use name=leverframe:<provider-id>:<model-id>.' };
  }

  const name = canonicalizeModelAliasName(value.slice(0, separator));
  if (name === null) {
    return { error: 'Alias names must be 1-64 letters, numbers, dots, underscores, or hyphens.' };
  }

  const rawTarget = value.slice(separator + 1).trim();
  const target = rawTarget.startsWith('leverframe:') ? rawTarget.slice('leverframe:'.length) : rawTarget;
  const targetSeparator = target.indexOf(':');
  if (targetSeparator < 1 || targetSeparator === target.length - 1) {
    return { error: 'Alias target must use leverframe:<provider-id>:<model-id>.' };
  }

  return {
    name,
    providerId: target.slice(0, targetSeparator),
    // `models --list` prints Claude's synthetic context suffix. It is a client
    // routing hint, not part of the provider catalog id stored in favorites.
    modelId: stripOneMContextSuffix(target.slice(targetSeparator + 1)),
  };
}

export function modelAliasTarget(alias: Pick<ModelAlias, 'providerId' | 'modelId'>): string {
  return `leverframe:${alias.providerId}:${alias.modelId}`;
}
