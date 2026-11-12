export const TRANSIENT_AUTH_COOLDOWN_MS = 30_000;

function authBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return body; }
}

function authEvidence(body: unknown): unknown[] {
  const payload = authBody(body);
  if (typeof payload === 'string') return [payload];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const details = payload as Record<string, unknown>;
  const error = details.error && typeof details.error === 'object' && !Array.isArray(details.error)
    ? details.error as Record<string, unknown> : undefined;
  return [details.message, details.status, details.statusCode, details.code, details.type,
    typeof details.error === 'string' ? details.error : undefined,
    error?.message, error?.status, error?.statusCode, error?.code, error?.type];
}

function transientEvidence(value: unknown): boolean {
  if (typeof value === 'number') return value === 429 || (value >= 500 && value <= 599);
  if (typeof value !== 'string') return false;
  return /\b(?:status(?:[_ ]?code)?|http)\s*[=:]?\s*(?:429|5\d{2})\b/i.test(value)
    || /\btoo many concurrent requests\b/i.test(value)
    || /^(?:429|5\d{2}|server_error|overloaded_error|rate_limit_error|too_many_requests|service_unavailable)$/i.test(value);
}

export function isTransientAuthFailure(statusCode: number | undefined, body: unknown): boolean {
  return statusCode === 401 && authEvidence(body).some(transientEvidence);
}
