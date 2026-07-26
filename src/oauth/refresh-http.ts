import type { OAuthTokenResponse } from './types.js';
import { withAbortTimeout } from './fetch-timeout.js';

export interface PostOAuthRefreshOptions {
  contentType: 'form' | 'json';
  errorPrefix: string;
  includeStatus?: boolean;
  includeBody?: boolean;
  headers?: Record<string, string>;
}

export async function postOAuthRefresh(
  url: string,
  body: URLSearchParams | Record<string, string>,
  options: PostOAuthRefreshOptions,
): Promise<OAuthTokenResponse> {
  const isJson = options.contentType === 'json';
  return withAbortTimeout(async signal => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...options.headers,
      },
      body: isJson ? JSON.stringify(body) : (body as URLSearchParams).toString(),
      signal,
    });

    if (!response.ok) {
      const detail = options.includeBody ? await response.text().catch(() => '') : '';
      const status = options.includeStatus ? ` (${response.status})` : '';
      throw new Error(`${options.errorPrefix}${status}${detail ? `: ${detail}` : ''}`);
    }

    return response.json() as Promise<OAuthTokenResponse>;
  }, `${options.errorPrefix}: request timed out`);
}
