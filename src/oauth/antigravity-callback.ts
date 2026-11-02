import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AntigravityError } from '../antigravity/types.js';

function callbackCode(req: IncomingMessage, res: ServerResponse, expectedState: string): string {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method !== 'GET' || url.pathname !== '/oauth-callback') {
    res.writeHead(404).end();
    return '';
  }
  const state = Buffer.from(url.searchParams.get('state') ?? '');
  const expected = Buffer.from(expectedState);
  if (state.length !== expected.length || !timingSafeEqual(state, expected)) {
    throw new AntigravityError('Antigravity authorization state did not match.', 400);
  }
  if (url.searchParams.has('error')) throw new AntigravityError('Antigravity authorization was denied.', 401);
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096) throw new AntigravityError('Antigravity authorization code is missing.', 400);
  return code;
}

export async function receiveAntigravityCode(options: {
  state: string; port: number; signal?: AbortSignal; timeoutMs: number;
  openAuthorization: (redirectUri: string) => void;
}): Promise<{ code: string; redirectUri: string }> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  let complete!: (value: string) => void;
  let fail!: (error: unknown) => void;
  const codePromise = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
  const abort = () => fail(new AntigravityError('Antigravity login cancelled or timed out.', 408));
  const server = createServer((req, res) => {
    try {
      const code = callbackCode(req, res, options.state);
      if (!code) return;
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Signed in. Return to Leverframe.');
      complete(code);
    } catch (error) {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Authorization failed. Return to Leverframe.');
      fail(error);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new AntigravityError('Antigravity callback listener failed.');
    const redirectUri = `http://localhost:${address.port}/oauth-callback`;
    signal.addEventListener('abort', abort, { once: true });
    options.openAuthorization(redirectUri);
    if (signal.aborted) abort();
    return { code: await codePromise, redirectUri };
  } finally {
    signal.removeEventListener('abort', abort);
    server.closeAllConnections();
    server.close();
  }
}
