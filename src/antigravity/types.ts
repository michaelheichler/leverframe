export interface AntigravityAuthSnapshot {
  accessToken: string;
  accountId: string;
  projectId: string;
}

export const ANTIGRAVITY_ORIGIN = 'https://daily-cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_SESSION_HEADER = 'x-leverframe-antigravity-session';
export const ANTIGRAVITY_REQUEST_TIMEOUT_MS = 20_000;

export class AntigravityError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly reason?: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'AntigravityError';
  }
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
