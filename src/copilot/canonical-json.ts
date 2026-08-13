/**
 * Produces one deterministic encoding for validated JSON values.
 * Non-JSON values fail before they can collapse into an ambiguous session hash.
 */

function encode(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON does not support cycles');

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => encode(item, nextAncestors)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => (
    `${JSON.stringify(key)}:${encode(record[key], nextAncestors)}`
  )).join(',')}}`;
}

/** Encodes JSON with sorted object keys and strict value validation. */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}
