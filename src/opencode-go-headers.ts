import { randomUUID } from 'node:crypto';
import { VERSION } from './constants.js';

export function openCodeGoHeaders(
  baseURL: string | undefined,
  headers?: Record<string, string>,
  sessionId?: string,
): Record<string, string> | undefined {
  if (!baseURL) return headers;
  const url = new URL(baseURL);
  if (url.hostname !== 'opencode.ai'
    || !/^\/(?:zen\/go|inference\/go)(?:\/|$)/.test(url.pathname)) return headers;
  const result = new Headers(headers);
  result.set('user-agent', `leverframe/${VERSION}`);
  result.set('x-opencode-session', sessionId || result.get('x-opencode-session') || randomUUID());
  return Object.fromEntries(result);
}

export function openCodeGoFetch(baseURL: string | undefined): typeof fetch | undefined {
  if (!openCodeGoHeaders(baseURL)) return undefined;
  return (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('user-agent', `leverframe/${VERSION}`);
    return fetch(input, { ...init, headers });
  };
}
