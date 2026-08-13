/**
 * Specifies GitHub device OAuth behavior without contacting GitHub.
 * All external responses and time are controlled by test doubles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  githubCopilotDeviceCodeUrl,
  pollGitHubCopilotDeviceCodeToken,
  requestGitHubCopilotDeviceCode,
  runGitHubCopilotDeviceCodeFlow,
} from '../src/oauth/github-copilot.js';

const DEVICE_CODE = 'fake-device-code-0123456789abcdef';
const USER_CODE = 'FAKE-1234';
const VERIFICATION_URI = 'https://github.test/login/device';
const ACCESS_TOKEN = ['fixture', 'access', 'token', 'for', 'tests', 'only'].join('-');

function deviceCodeData(overrides: Partial<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}>) {
  return {
    device_code: DEVICE_CODE,
    user_code: USER_CODE,
    verification_uri: VERIFICATION_URI,
    expires_in: 900,
    interval: 5,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function successTokenResponse() {
  return jsonResponse(200, { access_token: ACCESS_TOKEN, token_type: 'bearer', scope: '' });
}

function parseRequestBody(body: unknown): Record<string, string> {
  return typeof body === 'string'
    ? Object.fromEntries(new URLSearchParams(body))
    : {};
}

describe('requestGitHubCopilotDeviceCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests a device code without asking for any scope', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, deviceCodeData({})));
    vi.stubGlobal('fetch', fetchMock);

    const data = await requestGitHubCopilotDeviceCode(undefined);

    expect(data.device_code).toBe(DEVICE_CODE);
    expect(data.user_code).toBe(USER_CODE);
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const sentBody = parseRequestBody(init.body);
    expect(sentBody.scope ?? '').toBe('');
  });

  it('raises a clear error that includes the status code on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));

    await expect(requestGitHubCopilotDeviceCode(undefined)).rejects.toThrow(/503/);
  });

  it('raises a clear error when the response is missing required fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { user_code: USER_CODE })));

    await expect(requestGitHubCopilotDeviceCode(undefined)).rejects.toThrow();
  });

  it('rejects a verification URI that is not HTTPS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, deviceCodeData({
      verification_uri: 'http://github.test/login/device',
    }))));

    await expect(requestGitHubCopilotDeviceCode(undefined)).rejects.toThrow(/verification_uri/);
  });

  it('raises a clear error instead of an unhandled JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
      text: async () => '<html>not json</html>',
    }));

    await expect(requestGitHubCopilotDeviceCode(undefined)).rejects.toThrow();
  });

  it('does not request a device code after the caller aborts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(requestGitHubCopilotDeviceCode(controller.signal))
      .rejects.toThrow(/GitHub Copilot device authorization aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('githubCopilotDeviceCodeUrl', () => {
  it('returns the verification URI GitHub issued for this device code', () => {
    expect(githubCopilotDeviceCodeUrl(deviceCodeData({}))).toBe(VERIFICATION_URI);
  });
});

describe('pollGitHubCopilotDeviceCodeToken success and pending states', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves with the access token on the first successful poll', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(successTokenResponse()));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep, now: () => 0 });

    expect(result.tokens.access_token).toBe(ACCESS_TOKEN);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
  });

  it('keeps polling on authorization_pending until the user approves', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(successTokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await pollGitHubCopilotDeviceCodeToken(deviceCodeData({ interval: 5 }), { sleep, now: () => 0 });

    expect(result.tokens.access_token).toBe(ACCESS_TOKEN);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000);
  });

  it('adds five seconds to the poll interval on slow_down', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { error: 'slow_down' }))
      .mockResolvedValueOnce(successTokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await pollGitHubCopilotDeviceCodeToken(deviceCodeData({ interval: 5 }), { sleep, now: () => 0 });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 10_000);
  });
});

describe('pollGitHubCopilotDeviceCodeToken terminal GitHub error codes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects on expired_token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'expired_token' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/expired/i);
  });

  it('rejects on access_denied and tells the caller how to try again', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'access_denied' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/providers auth github-copilot/);
  });

  it('rejects on unsupported_grant_type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'unsupported_grant_type' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/unsupported_grant_type/);
  });

  it('rejects on incorrect_client_credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'incorrect_client_credentials' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/incorrect_client_credentials/);
  });

  it('rejects on incorrect_device_code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'incorrect_device_code' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/incorrect_device_code/);
  });

  it('rejects on device_flow_disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'device_flow_disabled' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/device_flow_disabled/);
  });
});

describe('pollGitHubCopilotDeviceCodeToken transport and shape errors', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('warns and retries transient HTTP failures before succeeding', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
      })
      .mockResolvedValueOnce(successTokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onWarning = vi.fn();

    const result = await pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), {
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
      onWarning,
    });

    expect(result.tokens.access_token).toBe(ACCESS_TOKEN);
    expect(onWarning).toHaveBeenCalledWith({
      endpoint: 'https://github.com/login/oauth/access_token',
      status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('raises the last transient HTTP error after bounded retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway',
    });
    vi.stubGlobal('fetch', fetchMock);
    const onWarning = vi.fn();

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), {
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
      onWarning,
    })).rejects.toThrow(/502/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onWarning).toHaveBeenCalledTimes(2);
  });

  it('raises a clear error when the response has neither access_token nor error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { token_type: 'bearer' })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow();
  });

  it('raises a clear error instead of an unhandled JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
      text: async () => '<html>not json</html>',
    }));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow();
  });

  it('rejects a successful response with an empty access token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      access_token: '',
      token_type: 'bearer',
      scope: '',
    })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/access_token/);
  });

  it('rejects a successful response with an unexpected token type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, {
      access_token: ACCESS_TOKEN,
      token_type: 'mac',
      scope: '',
    })));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), { sleep: vi.fn(), now: () => 0 }))
      .rejects.toThrow(/token_type/);
  });
});

describe('pollGitHubCopilotDeviceCodeToken secret redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('redacts the device code from upstream error text instead of leaking it', async () => {
    const data = deviceCodeData({});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => `Bad request for device_code=${data.device_code}, contact support`,
    }));

    let caught: Error | undefined;
    try {
      await pollGitHubCopilotDeviceCodeToken(data, { sleep: vi.fn(), now: () => 0 });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain(data.device_code);
    expect(caught?.message).toContain('[REDACTED]');
  });

  it('redacts secrets before truncating a long upstream error', async () => {
    const data = deviceCodeData({ device_code: 'DEVICE_CODE_BOUNDARY_SECRET' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => `${'x'.repeat(494)}${data.device_code}`,
    }));

    await expect(pollGitHubCopilotDeviceCodeToken(data, { sleep: vi.fn(), now: () => 0 }))
      .rejects.not.toThrow(/DEVICE/);
  });


  it('redacts a percent-encoded user code from an upstream error', async () => {
    const data = deviceCodeData({ user_code: 'FAKE-1234' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Rejected user_code=FAKE%2D1234',
    }));

    let caught: Error | undefined;
    try {
      await pollGitHubCopilotDeviceCodeToken(data, { sleep: vi.fn(), now: () => 0 });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).not.toContain('FAKE%2D1234');
    expect(caught?.message).toContain('[REDACTED]');
  });
});

describe('pollGitHubCopilotDeviceCodeToken timing and cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('times out once the deadline passes without a terminal response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { error: 'authorization_pending' })));
    let clock = 0;
    const now = () => {
      const value = clock;
      clock += 1_000;
      return value;
    };

    await expect(pollGitHubCopilotDeviceCodeToken(
      deviceCodeData({ expires_in: 2, interval: 1 }),
      { sleep: vi.fn().mockResolvedValue(undefined), now },
    )).rejects.toThrow(/timed out/i);
  });

  it('rejects immediately, without calling fetch, when the caller aborts before polling starts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), {
      sleep: vi.fn(),
      now: () => 0,
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe('pollGitHubCopilotDeviceCodeToken active cancellation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('maps an in-flight fetch abort to the provider-specific error', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_input, init: RequestInit) => {
      controller.abort();
      throw init.signal?.reason;
    }));

    await expect(pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), {
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
      signal: controller.signal,
    })).rejects.toThrow(/GitHub Copilot device authorization aborted/);
  });

  it('interrupts the current polling delay when the caller aborts', async () => {
    const controller = new AbortController();
    const poll = pollGitHubCopilotDeviceCodeToken(deviceCodeData({}), {
      sleep: () => new Promise<void>(() => undefined),
      now: () => 0,
      signal: controller.signal,
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('poll delay was not interrupted')), 100);
      timer.unref();
    });

    controller.abort();

    await expect(Promise.race([poll, deadline]))
      .rejects.toThrow(/GitHub Copilot device authorization aborted/);
  });
});

describe('runGitHubCopilotDeviceCodeFlow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests a device code, notifies the caller, and resolves with the access token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, deviceCodeData({})))
      .mockResolvedValueOnce(successTokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onDeviceCode = vi.fn();

    const result = await runGitHubCopilotDeviceCodeFlow(onDeviceCode, { sleep: vi.fn(), now: () => 0 });

    expect(onDeviceCode).toHaveBeenCalledWith({ url: VERIFICATION_URI, userCode: USER_CODE });
    expect(result.tokens.access_token).toBe(ACCESS_TOKEN);
  });
});
