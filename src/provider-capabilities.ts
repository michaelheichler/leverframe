// Provider capability matrix (stabilization plan §7.3).
//
// Declares what a provider/model combination actually supports, sourced
// from supplier metadata (models.dev-style catalog entries plus any
// Leverframe-local overrides). Recovery and routing code must consult this
// matrix instead of inferring support from a provider name string.

export interface SupplierCapabilityMetadata {
  providerId?: string;
  /** models.dev-style `supported_parameters` / feature flags, when available. */
  supportedParameters?: string[];
  streaming?: boolean;
  tools?: boolean;
  images?: boolean;
  /** `undefined` = unknown/inferred, `false` = supplier explicitly disclaims reasoning. */
  reasoning?: boolean;
  promptCache?: boolean;
  websocket?: boolean;
  conversationContinuation?: boolean;
  nativeResume?: boolean;
  idempotencyKeys?: boolean;
  requestStatusLookup?: boolean;
  stableToolCallIds?: boolean;
  serverManagedState?: boolean;
  clientManagedState?: boolean;
  credentialRotation?: boolean;
}

export type CapabilitySource = 'supplier-metadata' | 'local-override' | 'inferred';

export interface ProviderCapabilityMatrix {
  streaming: boolean;
  tools: boolean;
  images: boolean;
  reasoning: boolean;
  promptCache: boolean;
  websocket: boolean;
  /** Provider can continue an existing conversation server-side (vs. resending full history). */
  conversationContinuation: boolean;
  /** Provider can resume a specific in-flight/interrupted response natively. */
  nativeResume: boolean;
  /** Leverframe can reconstruct a continuation locally from preserved partial state when native resume is unavailable. */
  reconstructedRecovery: boolean;
  /** Leverframe may persist an execution checkpoint for this provider/model. */
  checkpoints: boolean;
  idempotencyKeys: boolean;
  requestStatusLookup: boolean;
  stableToolCallIds: boolean;
  serverManagedState: boolean;
  clientManagedState: boolean;
  credentialRotation: boolean;
  source: CapabilitySource;
}

const DEFAULT_CAPABILITIES: Omit<ProviderCapabilityMatrix, 'source'> = {
  streaming: false,
  tools: false,
  images: false,
  reasoning: false,
  promptCache: false,
  websocket: false,
  conversationContinuation: false,
  nativeResume: false,
  reconstructedRecovery: true,
  checkpoints: true,
  idempotencyKeys: false,
  requestStatusLookup: false,
  stableToolCallIds: false,
  serverManagedState: false,
  clientManagedState: true,
  credentialRotation: true,
};

/**
 * Local overrides (per provider id) applied after supplier metadata. Used
 * for providers/quirks the catalog metadata does not model correctly.
 * Values here follow the same "explicit false always wins" rule as
 * supplier metadata: an override may only narrow, never widen, a
 * supplier-declared `false`.
 */
export type CapabilityOverrides = Partial<Record<string, Partial<SupplierCapabilityMetadata>>>;

interface ResolveBooleanInput {
  supplierValue: boolean | undefined;
  overrideValue: boolean | undefined;
  fallback: boolean;
}

function resolveBoolean(input: ResolveBooleanInput): { value: boolean; explicit: boolean } {
  const { supplierValue, overrideValue, fallback } = input;
  // Explicit false from either source wins outright — a disclaimed capability
  // can never be re-enabled by a weaker signal.
  if (supplierValue === false || overrideValue === false) return { value: false, explicit: true };
  if (overrideValue === true) return { value: true, explicit: true };
  if (supplierValue === true) return { value: true, explicit: true };
  return { value: fallback, explicit: false };
}

export function buildProviderCapabilities(
  metadata: SupplierCapabilityMetadata,
  overrides: CapabilityOverrides = {},
): ProviderCapabilityMatrix {
  const override = metadata.providerId ? overrides[metadata.providerId] : undefined;
  let anyExplicit = false;

  const field = <K extends keyof SupplierCapabilityMetadata>(key: K, fallback: boolean): boolean => {
    const resolved = resolveBoolean({
      supplierValue: metadata[key] as boolean | undefined,
      overrideValue: override?.[key] as boolean | undefined,
      fallback,
    });
    if (resolved.explicit) anyExplicit = true;
    return resolved.value;
  };

  const matrix: ProviderCapabilityMatrix = {
    streaming: field('streaming', DEFAULT_CAPABILITIES.streaming),
    tools: field('tools', DEFAULT_CAPABILITIES.tools),
    images: field('images', DEFAULT_CAPABILITIES.images),
    reasoning: field('reasoning', DEFAULT_CAPABILITIES.reasoning),
    promptCache: field('promptCache', DEFAULT_CAPABILITIES.promptCache),
    websocket: field('websocket', DEFAULT_CAPABILITIES.websocket),
    conversationContinuation: field('conversationContinuation', DEFAULT_CAPABILITIES.conversationContinuation),
    nativeResume: field('nativeResume', DEFAULT_CAPABILITIES.nativeResume),
    reconstructedRecovery: DEFAULT_CAPABILITIES.reconstructedRecovery,
    checkpoints: DEFAULT_CAPABILITIES.checkpoints,
    idempotencyKeys: field('idempotencyKeys', DEFAULT_CAPABILITIES.idempotencyKeys),
    requestStatusLookup: field('requestStatusLookup', DEFAULT_CAPABILITIES.requestStatusLookup),
    stableToolCallIds: field('stableToolCallIds', DEFAULT_CAPABILITIES.stableToolCallIds),
    serverManagedState: field('serverManagedState', DEFAULT_CAPABILITIES.serverManagedState),
    clientManagedState: field('clientManagedState', DEFAULT_CAPABILITIES.clientManagedState),
    credentialRotation: field('credentialRotation', DEFAULT_CAPABILITIES.credentialRotation),
    source: 'inferred',
  };

  // A provider that cannot resume natively can only fall back to reconstruction
  // if it at least exposes client-managed conversation state to rebuild from.
  matrix.reconstructedRecovery = !matrix.nativeResume && matrix.clientManagedState;
  // Checkpoints are only meaningful when we have some form of recovery path.
  matrix.checkpoints = matrix.nativeResume || matrix.reconstructedRecovery;
  matrix.source = override && anyExplicit
    ? 'local-override'
    : anyExplicit
      ? 'supplier-metadata'
      : 'inferred';

  return matrix;
}

export type CapabilityName = keyof Omit<ProviderCapabilityMatrix, 'source'>;

export class UnsupportedCapabilityError extends Error {
  readonly code = 'unsupported_capability';
  readonly capability: CapabilityName;
  readonly providerId?: string;

  constructor(capability: CapabilityName, providerId?: string) {
    super(
      providerId
        ? `Provider "${providerId}" does not support ${capability}.`
        : `Provider does not support ${capability}.`,
    );
    this.name = 'UnsupportedCapabilityError';
    this.capability = capability;
    this.providerId = providerId;
  }

  static isInstance(value: unknown): value is UnsupportedCapabilityError {
    if (value instanceof UnsupportedCapabilityError) return true;
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<UnsupportedCapabilityError>;
    return candidate.name === 'UnsupportedCapabilityError' && candidate.code === 'unsupported_capability';
  }
}

export interface RequireCapabilityInput {
  matrix: ProviderCapabilityMatrix;
  capability: CapabilityName;
  providerId?: string;
}

/** Runtime enforcement point: throws {@link UnsupportedCapabilityError} unless `capability` is declared. */
export function requireCapability(input: RequireCapabilityInput): void {
  if (!input.matrix[input.capability]) {
    throw new UnsupportedCapabilityError(input.capability, input.providerId);
  }
}
