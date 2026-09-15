/** Because GitHub credentials must stay on its own API. */
import { VERSION } from '../constants.js';
import { CopilotModelValidationError } from './model-metadata.js';

export const COPILOT_API_BASE_URL = 'https://api.githubcopilot.com';
const CATALOG_API_VERSION = '2025-10-01';
const INFERENCE_API_VERSION = '2025-05-01';
const CATALOG_BODY_LIMIT = 8 * 1024 * 1024;
const ERROR_BODY_LIMIT = 64 * 1024;
const REQUEST_PATHS = new Set(['/models', '/chat/completions', '/responses', '/v1/messages']);
const PROTOCOL_HEADERS = ['accept', 'content-type', 'anthropic-version', 'anthropic-beta'];

/** Because failures need status, not private bodies. */
export class CopilotHttpError extends Error {
  /** Because HTTP failures must remain classifiable. */
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'CopilotHttpError';
  }
}

/** Because only the Copilot origin can receive OAuth. */
function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    throw new TypeError('GitHub Copilot request URL is invalid.');
  }
  if (url.origin !== COPILOT_API_BASE_URL || url.username || url.password || url.search || url.hash || !REQUEST_PATHS.has(url.pathname)) {
    throw new TypeError('GitHub Copilot request endpoint is not allowed.');
  }
  return url;
}

/** Because inherited headers can leak credentials. */
function requestHeaders(request: Request, token: string, path: string): Headers {
  const headers = new Headers();
  for (const name of PROTOCOL_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const identity = `leverframe/${VERSION}`;
  headers.set('authorization', `Bearer ${token}`);
  headers.set('user-agent', identity);
  headers.set('editor-version', identity);
  headers.set('editor-plugin-version', identity);
  headers.set('x-github-api-version', path === '/models' ? CATALOG_API_VERSION : INFERENCE_API_VERSION);
  return headers;
}

/** Because response bodies need a fixed size limit. */
async function responseText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > limit) {
      throw new CopilotHttpError(response.status >= 400 ? response.status : 502, 'GitHub Copilot response exceeds the size limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Because upstream errors can echo authorization. */
async function redactedFailure(response: Response, token: string): Promise<Response> {
  const text = (await responseText(response, ERROR_BODY_LIMIT)).replaceAll(token, '[redacted]');
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  for (const [name, value] of headers) headers.set(name, value.replaceAll(token, '[redacted]'));
  return new Response(text, {
    status: response.status,
    statusText: response.statusText.replaceAll(token, '[redacted]'),
    headers,
  });
}

/** Because OAuth belongs only on the outgoing request. */
export function createCopilotFetch(githubToken: string, fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
  if (typeof githubToken !== 'string' || !/^[\x21-\x7e]+$/.test(githubToken)) {
    throw new TypeError('GitHub Copilot requires a valid GitHub OAuth credential.');
  }
  return async (input, init) => {
    const url = requestUrl(input);
    const request = new Request(input instanceof Request ? input : url, init);
    if (request.url !== url.href || request.method !== (url.pathname === '/models' ? 'GET' : 'POST')) {
      throw new TypeError('GitHub Copilot request method or endpoint is not allowed.');
    }
    request.signal.throwIfAborted();
    const outgoing = new Request(request, {
      headers: requestHeaders(request, githubToken, url.pathname), redirect: 'manual',
    });
    const response = await fetchImpl(outgoing);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new CopilotHttpError(502, 'GitHub Copilot returned an unsupported redirect.');
    }
    return response.ok ? response : redactedFailure(response, githubToken);
  };
}

/** Because discovery needs HTTP, not a vendor runtime. */
export async function fetchCopilotModels(
  githubToken: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<unknown[]> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await createCopilotFetch(githubToken, options.fetchImpl)(`${COPILOT_API_BASE_URL}/models`, { signal });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new CopilotHttpError(response.status, `GitHub Copilot model discovery failed with HTTP ${response.status}.`);
  }
  const text = await responseText(response, CATALOG_BODY_LIMIT);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new CopilotModelValidationError('GitHub Copilot returned an invalid model catalog.'); }
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
    throw new CopilotModelValidationError('GitHub Copilot returned an invalid model catalog.');
  }
  return body.data;
}
