export const SUMMARY_SCHEMA_VERSION = 1 as const;

export type SummarySourceId = string;
export type SummaryItemKind = 'fact' | 'decision' | 'tool' | 'chronology';

export interface SummaryItem {
  text: string;
  sourceIds: readonly SummarySourceId[];
}

export interface SummaryFileReference {
  path: string;
  relation: 'changed' | 'referenced';
  sourceIds: readonly SummarySourceId[];
}

export interface SummaryToolOutcome extends SummaryItem {
  status: 'succeeded' | 'failed' | 'unresolved';
}

export interface SummaryChronologyItem extends SummaryItem {
  order: number;
}

export interface StructuredSynopsis {
  version: typeof SUMMARY_SCHEMA_VERSION;
  taskGoal: string;
  userDecisions: readonly SummaryItem[];
  constraints: readonly SummaryItem[];
  verifiedFacts: readonly SummaryItem[];
  files: readonly SummaryFileReference[];
  toolOutcomes: readonly SummaryToolOutcome[];
  unresolved: readonly SummaryItem[];
  failedApproaches: readonly SummaryItem[];
  nextActions: readonly SummaryItem[];
  chronology: readonly SummaryChronologyItem[];
}

export interface SynopsisCheckerResult {
  unsupportedClaims?: readonly string[];
}

export interface SynopsisAcceptancePolicy {
  requiredSourceIds?: readonly SummarySourceId[];
  minimumProvenanceCoverage?: number;
  minimumReductionRatio?: number;
  sourceIdPattern?: RegExp;
}

export interface SynopsisAcceptanceInput {
  candidate: unknown;
  suppliedSourceIds: readonly SummarySourceId[];
  inputTokens: number;
  candidateTokens?: number;
  checker?: SynopsisCheckerResult;
  policy?: SynopsisAcceptancePolicy;
  priorValidGeneration?: StructuredSynopsis;
}

export type SynopsisRejectionCode =
  | 'malformed_output'
  | 'unknown_field'
  | 'invalid_field'
  | 'duplicate_item'
  | 'invalid_source_id'
  | 'unknown_source_id'
  | 'missing_required_source'
  | 'insufficient_provenance_coverage'
  | 'unsupported_claim'
  | 'unresolved_tool_provenance'
  | 'reduction_target_not_met';

export interface SynopsisAcceptanceResult {
  accepted: boolean;
  synopsis?: StructuredSynopsis;
  priorValidGenerationRetained: boolean;
  rejectionCodes: readonly SynopsisRejectionCode[];
  coveredSourceIds: readonly SummarySourceId[];
}

const MAX_TEXT = 2_048;
const MAX_GOAL = 4_096;
const MAX_ITEMS = 256;
const MAX_FILES = 256;
const MAX_SOURCE_IDS = 16;
const DEFAULT_SOURCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const FILE_PATH = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

const SYNOPSIS_FIELDS = new Set([
  'version', 'taskGoal', 'userDecisions', 'constraints', 'verifiedFacts', 'files',
  'toolOutcomes', 'unresolved', 'failedApproaches', 'nextActions', 'chronology',
]);
const ITEM_FIELDS = new Set(['text', 'sourceIds']);
const FILE_FIELDS = new Set(['path', 'relation', 'sourceIds']);
const TOOL_FIELDS = new Set(['text', 'sourceIds', 'status']);
const CHRONOLOGY_FIELDS = new Set(['text', 'sourceIds', 'order']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function exactFields(value: Record<string, unknown>, allowed: Set<string>): SynopsisRejectionCode | undefined {
  return Object.keys(value).some(key => !allowed.has(key)) ? 'unknown_field' : undefined;
}

function sourceIds(value: unknown, supplied: ReadonlySet<string>, pattern: RegExp): { ids?: SummarySourceId[]; code?: SynopsisRejectionCode } {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_IDS || value.some(id => typeof id !== 'string')) return { code: 'invalid_source_id' };
  const ids = value as string[];
  if (new Set(ids).size !== ids.length || ids.some(id => !pattern.test(id))) return { code: 'invalid_source_id' };
  if (ids.some(id => !supplied.has(id))) return { code: 'unknown_source_id' };
  return { ids };
}

function item(value: unknown, allowed: Set<string>, supplied: ReadonlySet<string>, pattern: RegExp): { item?: SummaryItem; code?: SynopsisRejectionCode } {
  if (!isRecord(value)) return { code: 'malformed_output' };
  const unknown = exactFields(value, allowed);
  if (unknown) return { code: unknown };
  if (!boundedText(value.text, MAX_TEXT)) return { code: 'invalid_field' };
  const sources = sourceIds(value.sourceIds, supplied, pattern);
  if (!sources.ids) return { code: sources.code };
  return { item: Object.freeze({ text: value.text, sourceIds: Object.freeze(sources.ids) }) };
}

function uniqueItems(items: readonly SummaryItem[]): SynopsisRejectionCode | undefined {
  const keys = items.map(entry => `${entry.text}\u0000${entry.sourceIds.join(',')}`);
  return new Set(keys).size === keys.length ? undefined : 'duplicate_item';
}

function list(value: unknown, allowed: Set<string>, supplied: ReadonlySet<string>, pattern: RegExp): { items?: SummaryItem[]; code?: SynopsisRejectionCode } {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return { code: 'invalid_field' };
  const items: SummaryItem[] = [];
  for (const entry of value) {
    const parsed = item(entry, allowed, supplied, pattern);
    if (!parsed.item) return { code: parsed.code };
    items.push(parsed.item);
  }
  return { items, code: uniqueItems(items) };
}

function parseSynopsis(value: unknown, supplied: ReadonlySet<string>, pattern: RegExp): { synopsis?: StructuredSynopsis; codes: SynopsisRejectionCode[]; covered: Set<string> } {
  const codes: SynopsisRejectionCode[] = [];
  const covered = new Set<string>();
  if (!isRecord(value)) return { codes: ['malformed_output'], covered };
  const unknown = exactFields(value, SYNOPSIS_FIELDS);
  if (unknown) return { codes: [unknown], covered };
  if (value.version !== SUMMARY_SCHEMA_VERSION || !boundedText(value.taskGoal, MAX_GOAL)) return { codes: ['invalid_field'], covered };
  const parseList = (name: string, allowed = ITEM_FIELDS): SummaryItem[] => {
    const parsed = list(value[name], allowed, supplied, pattern);
    if (parsed.code) codes.push(parsed.code);
    if (!parsed.items) return [];
    parsed.items.forEach(entry => entry.sourceIds.forEach(id => covered.add(id)));
    return parsed.items;
  };
  const userDecisions = parseList('userDecisions');
  const constraints = parseList('constraints');
  const verifiedFacts = parseList('verifiedFacts');
  const unresolved = parseList('unresolved');
  const failedApproaches = parseList('failedApproaches');
  const nextActions = parseList('nextActions');
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) codes.push('invalid_field');
  const files: SummaryFileReference[] = [];
  for (const entry of Array.isArray(value.files) ? value.files : []) {
    if (!isRecord(entry) || exactFields(entry, FILE_FIELDS) || !boundedText(entry.path, 512) || !FILE_PATH.test(entry.path) || (entry.relation !== 'changed' && entry.relation !== 'referenced')) {
      codes.push(!isRecord(entry) || exactFields(entry, FILE_FIELDS) ? 'unknown_field' : 'invalid_field');
      continue;
    }
    const sources = sourceIds(entry.sourceIds, supplied, pattern);
    if (!sources.ids) { codes.push(sources.code ?? 'invalid_source_id'); continue; }
    sources.ids.forEach(id => covered.add(id));
    files.push(Object.freeze({ path: entry.path, relation: entry.relation, sourceIds: Object.freeze(sources.ids) }));
  }
  if (new Set(files.map(file => `${file.relation}:${file.path}`)).size !== files.length) codes.push('duplicate_item');
  const tools: SummaryToolOutcome[] = [];
  if (!Array.isArray(value.toolOutcomes) || value.toolOutcomes.length > MAX_ITEMS) codes.push('invalid_field');
  for (const entry of Array.isArray(value.toolOutcomes) ? value.toolOutcomes : []) {
    const parsed = item(entry, TOOL_FIELDS, supplied, pattern);
    if (!parsed.item || (entry as Record<string, unknown>).status !== 'succeeded' && (entry as Record<string, unknown>).status !== 'failed' && (entry as Record<string, unknown>).status !== 'unresolved') {
      codes.push(parsed.code ?? 'invalid_field');
      continue;
    }
    if (entry.status === 'unresolved') codes.push('unresolved_tool_provenance');
    parsed.item.sourceIds.forEach(id => covered.add(id));
    tools.push(Object.freeze({ ...parsed.item, status: entry.status }));
  }
  const chronology: SummaryChronologyItem[] = [];
  if (!Array.isArray(value.chronology) || value.chronology.length > MAX_ITEMS) codes.push('invalid_field');
  for (const entry of Array.isArray(value.chronology) ? value.chronology : []) {
    const parsed = item(entry, CHRONOLOGY_FIELDS, supplied, pattern);
    if (!parsed.item || !finiteNonnegative((entry as Record<string, unknown>).order)) { codes.push(parsed.code ?? 'invalid_field'); continue; }
    parsed.item.sourceIds.forEach(id => covered.add(id));
    chronology.push(Object.freeze({ ...parsed.item, order: entry.order }));
  }
  const orders = chronology.map(entry => entry.order);
  if (new Set(orders).size !== orders.length || orders.some((order, index) => index > 0 && order <= orders[index - 1])) codes.push('invalid_field');
  if (codes.length > 0) return { codes: [...new Set(codes)], covered };
  return { synopsis: Object.freeze({ version: SUMMARY_SCHEMA_VERSION, taskGoal: value.taskGoal, userDecisions: Object.freeze(userDecisions), constraints: Object.freeze(constraints), verifiedFacts: Object.freeze(verifiedFacts), files: Object.freeze(files), toolOutcomes: Object.freeze(tools), unresolved: Object.freeze(unresolved), failedApproaches: Object.freeze(failedApproaches), nextActions: Object.freeze(nextActions), chronology: Object.freeze(chronology) }), codes, covered };
}

export function validateStructuredSynopsis(value: unknown, suppliedSourceIds: readonly SummarySourceId[], sourceIdPattern = DEFAULT_SOURCE_ID_PATTERN): SynopsisAcceptanceResult {
  const supplied = new Set(suppliedSourceIds);
  const parsed = parseSynopsis(value, supplied, sourceIdPattern);
  return { accepted: Boolean(parsed.synopsis), ...(parsed.synopsis ? { synopsis: parsed.synopsis } : {}), priorValidGenerationRetained: false, rejectionCodes: parsed.codes, coveredSourceIds: Object.freeze([...parsed.covered]) };
}

export function acceptStructuredSynopsis(input: SynopsisAcceptanceInput): SynopsisAcceptanceResult {
  const policy = input.policy ?? {};
  const supplied = new Set(input.suppliedSourceIds);
  const parsed = parseSynopsis(input.candidate, supplied, policy.sourceIdPattern ?? DEFAULT_SOURCE_ID_PATTERN);
  const codes = [...parsed.codes];
  if (input.checker?.unsupportedClaims && input.checker.unsupportedClaims.length > 0) codes.push('unsupported_claim');
  const required = new Set(policy.requiredSourceIds ?? input.suppliedSourceIds);
  const coverage = required.size === 0 ? 1 : [...required].filter(id => parsed.covered.has(id)).length / required.size;
  if ([...required].some(id => !supplied.has(id))) codes.push('unknown_source_id');
  if ([...required].some(id => !parsed.covered.has(id))) codes.push('missing_required_source');
  if (coverage < (policy.minimumProvenanceCoverage ?? 1)) codes.push('insufficient_provenance_coverage');
  if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens <= 0) codes.push('invalid_field');
  const reductionTarget = policy.minimumReductionRatio ?? 0;
  if (reductionTarget < 0 || reductionTarget >= 1 || !Number.isFinite(reductionTarget)) codes.push('invalid_field');
  const candidateTokens = input.candidateTokens ?? (parsed.synopsis === undefined ? 0 : JSON.stringify(parsed.synopsis).length / 4);
  if (!Number.isFinite(candidateTokens) || candidateTokens < 0) codes.push('invalid_field');
  if (parsed.synopsis && input.inputTokens > 0 && candidateTokens > input.inputTokens * (1 - reductionTarget)) codes.push('reduction_target_not_met');
  const rejectionCodes = Object.freeze([...new Set(codes)]);
  return { accepted: parsed.synopsis !== undefined && rejectionCodes.length === 0, ...(parsed.synopsis && rejectionCodes.length === 0 ? { synopsis: parsed.synopsis } : {}), priorValidGenerationRetained: rejectionCodes.length > 0 && input.priorValidGeneration !== undefined, rejectionCodes, coveredSourceIds: Object.freeze([...parsed.covered]) };
}