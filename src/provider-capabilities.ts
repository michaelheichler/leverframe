

export interface SupplierCapabilityMetadata {
  providerId?: string;

  supportedParameters?: string[];
  streaming?: boolean;
  tools?: boolean;
  images?: boolean;

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

  conversationContinuation: boolean;

  nativeResume: boolean;

  reconstructedRecovery: boolean;

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

export type CapabilityOverrides = Partial<Record<string, Partial<SupplierCapabilityMetadata>>>;

interface ResolveBooleanInput {
  supplierValue: boolean | undefined;
  overrideValue: boolean | undefined;
  fallback: boolean;
}

function resolveBoolean(input: ResolveBooleanInput): { value: boolean; explicit: boolean } {
  const { supplierValue, overrideValue, fallback } = input;

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

  matrix.reconstructedRecovery = !matrix.nativeResume && matrix.clientManagedState;

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

export function requireCapability(input: RequireCapabilityInput): void {
  if (!input.matrix[input.capability]) {
    throw new UnsupportedCapabilityError(input.capability, input.providerId);
  }
}
