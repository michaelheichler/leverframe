/**
 * Owns GitHub OAuth App device authorization for Copilot subscriptions.
 * It stores only the durable GitHub bearer token. The Copilot SDK owns its internal tokens.
 */

import { OAUTH_REQUEST_TIMEOUT_MS, withAbortTimeout } from './fetch-timeout.js';
import type { OAuthTokenResponse, StoredOAuthCredential } from './types.js';

const CLIENT_ID = 'Ov23liGIthyyjFMYk6ai';
const DEVICE_CODE_ENDPOINT = 'https://github.com/login/device/code';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_INCREMENT_MS = 5_000;
const MAX_TRANSIENT_RETRIES = 2;
const NON_EXPIRING_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

export interface GitHubCopilotDeviceCodeData {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GitHubCopilotTokenData {
  access_token: string;
  token_type: 'bearer';
  scope: string;
}

interface GitHubCopilotPollingErrorData {
  error: string;
  interval?: number;
}

export interface GitHubCopilotPollingOptions {
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  signal?: AbortSignal;
  onWarning?: (warning: { endpoint: string; status: number }) => void;
}

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown, endpoint: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`GitHub Copilot OAuth response from ${endpoint} must be a JSON object`);
  }
  return value as JsonRecord;
}

function requireNonEmptyString(record: JsonRecord, field: string, endpoint: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`GitHub Copilot OAuth response from ${endpoint} has invalid ${field}`);
  }
  return value;
}

function requireHttpsUrl(record: JsonRecord, field: string, endpoint: string): string {
  const value = requireNonEmptyString(record, field, endpoint);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError(`GitHub Copilot OAuth response from ${endpoint} has invalid ${field}`, {
      cause: error,
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new TypeError(`GitHub Copilot OAuth response from ${endpoint} has invalid ${field}`);
  }
  return value;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function requirePositiveNumber(record: JsonRecord, field: string, endpoint: string): number {
  const value = record[field];
  if (!isPositiveNumber(value)) {
    throw new TypeError(`GitHub Copilot OAuth response from ${endpoint} has invalid ${field}`);
  }
  return value;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce((redacted, secret) => {
    if (secret.length === 0) return redacted;
    const variants = new Set([
      secret,
      secret.toLowerCase(),
      secret.toUpperCase(),
      secret.replaceAll('-', '%2D'),
      secret.replaceAll('-', '%2d'),
    ]);
    return [...variants].reduce(
      (result, variant) => result.replaceAll(variant, '[REDACTED]'),
      redacted,
    );
  }, value);
}

async function readJsonRecord(response: Response, endpoint: string): Promise<JsonRecord> {
  const responseText = await response.text();
  try {
    return requireRecord(JSON.parse(responseText) as unknown, endpoint);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('GitHub Copilot OAuth response')) {
      throw error;
    }
    throw new TypeError(`GitHub Copilot OAuth response from ${endpoint} is not valid JSON`, {
      cause: error,
    });
  }
}

async function readSuccessfulJson(input: {
  response: Response;
  endpoint: string;
  secrets: readonly string[];
}): Promise<JsonRecord> {
  if (!input.response.ok) {
    const responseText = await input.response.text();
    const reason = redactSecrets(responseText, input.secrets).slice(0, 500);
    throw new Error(
      `GitHub Copilot OAuth request to ${input.endpoint} failed with HTTP ${input.response.status}: ${reason}`,
    );
  }
  return readJsonRecord(input.response, input.endpoint);
}

function parseDeviceCodeData(record: JsonRecord): GitHubCopilotDeviceCodeData {
  return {
    device_code: requireNonEmptyString(record, 'device_code', DEVICE_CODE_ENDPOINT),
    user_code: requireNonEmptyString(record, 'user_code', DEVICE_CODE_ENDPOINT),
    verification_uri: requireHttpsUrl(record, 'verification_uri', DEVICE_CODE_ENDPOINT),
    expires_in: requirePositiveNumber(record, 'expires_in', DEVICE_CODE_ENDPOINT),
    interval: requirePositiveNumber(record, 'interval', DEVICE_CODE_ENDPOINT),
  };
}

function parseTokenData(record: JsonRecord): GitHubCopilotTokenData | GitHubCopilotPollingErrorData {
  if (typeof record.error === 'string' && record.error.length > 0) {
    const interval = record.interval;
    if (interval !== undefined && !isPositiveNumber(interval)) {
      throw new TypeError(`GitHub Copilot OAuth response from ${TOKEN_ENDPOINT} has invalid interval`);
    }
    return {
      error: record.error,
      ...(typeof interval === 'number' ? { interval } : {}),
    };
  }

  const accessToken = requireNonEmptyString(record, 'access_token', TOKEN_ENDPOINT);
  const tokenType = requireNonEmptyString(record, 'token_type', TOKEN_ENDPOINT);
  if (tokenType.toLowerCase() !== 'bearer') {
    throw new TypeError(`GitHub Copilot OAuth response from ${TOKEN_ENDPOINT} has invalid token_type`);
  }
  const scope = record.scope;
  if (typeof scope !== 'string') {
    throw new TypeError(`GitHub Copilot OAuth response from ${TOKEN_ENDPOINT} has invalid scope`);
  }
  return { access_token: accessToken, token_type: 'bearer', scope };
}

function throwIfAborted(signal: AbortSignal | undefined, cause: unknown): void {
  if (signal?.aborted === true) {
    throw new Error('GitHub Copilot device authorization aborted', { cause });
  }
}

async function runAbortableRequest<T>(input: {
  operation: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal | undefined;
  timeoutMessage: string;
  timeoutMs: number;
}): Promise<T> {
  throwIfAborted(input.signal, input.signal?.reason);
  try {
    return await withAbortTimeout(
      timeoutSignal => input.operation(
        input.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([timeoutSignal, input.signal]),
      ),
      input.timeoutMessage,
      input.timeoutMs,
    );
  } catch (error) {
    throwIfAborted(input.signal, error);
    throw error;
  }
}

async function sleepUntilNextPoll(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal, signal?.reason);
  if (signal === undefined) {
    await sleep(milliseconds);
    return;
  }

  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('GitHub Copilot device authorization aborted', {
      cause: signal.reason,
    }));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function tokenPollingFailure(error: string): Error {
  if (error === 'expired_token') {
    return new Error('GitHub Copilot device authorization expired; run leverframe providers auth github-copilot');
  }
  if (error === 'access_denied') {
    return new Error('GitHub Copilot device authorization was denied; run leverframe providers auth github-copilot');
  }
  if (error === 'device_flow_disabled') {
    return new Error('GitHub Copilot device authorization failed with device_flow_disabled; enable device flow for the Leverframe OAuth App');
  }
  return new Error(`GitHub Copilot device authorization failed with ${error}`);
}

/** Requests an unscoped device code from the Leverframe GitHub OAuth App. */
export async function requestGitHubCopilotDeviceCode(
  signal: AbortSignal | undefined,
): Promise<GitHubCopilotDeviceCodeData> {
  const response = await runAbortableRequest({
    operation: requestSignal => fetch(DEVICE_CODE_ENDPOINT, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
      signal: requestSignal,
    }),
    signal,
    timeoutMessage: 'GitHub Copilot device-code request timed out',
    timeoutMs: OAUTH_REQUEST_TIMEOUT_MS,
  });
  return parseDeviceCodeData(await readSuccessfulJson({
    response,
    endpoint: DEVICE_CODE_ENDPOINT,
    secrets: [],
  }));
}

/** Returns the verification location supplied for this device authorization. */
export function githubCopilotDeviceCodeUrl(deviceData: GitHubCopilotDeviceCodeData): string {
  return deviceData.verification_uri;
}

/** Polls at GitHub's required interval until authorization succeeds or terminates. */
export async function pollGitHubCopilotDeviceCodeToken(
  deviceData: GitHubCopilotDeviceCodeData,
  options: GitHubCopilotPollingOptions,
): Promise<{ tokens: OAuthTokenResponse; accountId?: string }> {
  const deadline = options.now() + deviceData.expires_in * 1_000;
  let intervalMs = deviceData.interval * 1_000;
  let transientFailures = 0;

  while (options.now() < deadline) {
    await sleepUntilNextPoll(
      options.sleep,
      Math.min(intervalMs, Math.max(0, deadline - options.now())),
      options.signal,
    );
    throwIfAborted(options.signal, options.signal?.reason);
    if (options.now() >= deadline) break;

    const remainingMs = Math.max(0, deadline - options.now());
    const response = await runAbortableRequest({
      operation: requestSignal => fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: deviceData.device_code,
          grant_type: DEVICE_GRANT_TYPE,
        }).toString(),
        signal: requestSignal,
      }),
      signal: options.signal,
      timeoutMessage: 'GitHub Copilot device token request timed out',
      timeoutMs: Math.min(OAUTH_REQUEST_TIMEOUT_MS, remainingMs),
    });
    if (response.status === 429 || response.status >= 500) {
      if (transientFailures < MAX_TRANSIENT_RETRIES) {
        transientFailures += 1;
        options.onWarning?.({ endpoint: TOKEN_ENDPOINT, status: response.status });
        continue;
      }
    } else {
      transientFailures = 0;
    }
    const record = await readSuccessfulJson({
      response,
      endpoint: TOKEN_ENDPOINT,
      secrets: [deviceData.device_code, deviceData.user_code],
    });
    const result = parseTokenData(record);
    if ('access_token' in result) {
      return { tokens: { access_token: result.access_token } };
    }
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') {
      intervalMs = Math.max(
        intervalMs + SLOW_DOWN_INCREMENT_MS,
        (result.interval ?? 0) * 1_000,
      );
      continue;
    }
    throw tokenPollingFailure(result.error);
  }

  throw new Error('GitHub Copilot device authorization timed out');
}

/** Runs one device authorization attempt and reports the user-facing code once. */
export async function runGitHubCopilotDeviceCodeFlow(
  onDeviceCode: (info: { url: string; userCode: string }) => void,
  options: GitHubCopilotPollingOptions,
): Promise<{ tokens: OAuthTokenResponse; accountId?: string }> {
  const deviceData = await requestGitHubCopilotDeviceCode(options.signal);
  onDeviceCode({
    url: githubCopilotDeviceCodeUrl(deviceData),
    userCode: deviceData.user_code,
  });
  return pollGitHubCopilotDeviceCodeToken(deviceData, options);
}

/** Converts a GitHub OAuth token into a durable, JSON-safe keychain credential. */
export function githubCopilotTokensToStoredCredential(
  tokens: OAuthTokenResponse,
): StoredOAuthCredential {
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new TypeError('GitHub Copilot OAuth access token must be a non-empty string');
  }
  return {
    type: 'oauth',
    access: tokens.access_token,
    refresh: '',
    expires: NON_EXPIRING_EXPIRES_AT,
  };
}
