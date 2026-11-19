import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

const CALLBACK_PATH = '/auth/callback';
const LOOPBACK = '127.0.0.1';

function checkedCallback(params: URLSearchParams, state: string, existingClientId?: string) {
  if (['state', 'code', 'client_id', 'error'].some(name => params.getAll(name).length > 1)) {
    throw new Error('ChatGPT returned duplicate authorization parameters.');
  }
  const returnedState = Buffer.from(params.get('state') ?? '');
  const expectedState = Buffer.from(state);
  if (returnedState.length !== expectedState.length || !timingSafeEqual(returnedState, expectedState)) {
    throw new Error('ChatGPT authorization state did not match.');
  }
  if (params.has('error')) throw new Error('ChatGPT did not grant authorization.');
  const code = params.get('code');
  const returnedClientId = params.get('client_id');
  const clientId = existingClientId ?? returnedClientId;
  if (!clientId || !/^oaiapp_[A-Za-z0-9_-]{1,240}$/.test(clientId)
    || (returnedClientId !== null && returnedClientId !== clientId)) {
    throw new Error('ChatGPT returned an invalid client registration.');
  }
  if (!code || code.length > 4096) throw new Error('ChatGPT authorization code is missing or invalid.');
  return { code, clientId };
}

export async function receiveChatGptPlanCallback(options: {
  state: string;
  existingClientId?: string;
  signal: AbortSignal;
  openAuthorization: (redirectUri: string) => void;
}) {
  options.signal.throwIfAborted();
  return new Promise<ReturnType<typeof checkedCallback> & { redirectUri: string }>((resolve, reject) => {
    let redirectUri: string;
    const abort = () => {
      fail(options.signal.reason);
      server.closeAllConnections();
    };
    const close = () => {
      options.signal.removeEventListener('abort', abort);
      server.close();
      server.closeIdleConnections();
    };
    const fail = (error: unknown) => {
      close();
      reject(error);
    };
    const server = createServer({ requestTimeout: 15_000, headersTimeout: 15_000 }, (request, response) => {
      const target = request.url ?? '';
      if (request.method !== 'GET' || target.split('?', 1)[0] !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const headers = { 'content-type': 'text/plain', 'cache-control': 'no-store', connection: 'close' };
      try {
        const result = checkedCallback(new URLSearchParams(target.slice(CALLBACK_PATH.length)), options.state, options.existingClientId);
        response.writeHead(200, headers).end('Return to Leverframe to finish signing in.');
        close();
        resolve({ ...result, redirectUri });
      } catch (error) {
        response.writeHead(400, headers).end('Authorization failed. Return to Leverframe.');
        fail(error);
      }
    });
    options.signal.addEventListener('abort', abort, { once: true });
    const listening = once(server, 'listening');
    server.listen(0, LOOPBACK);
    void listening.then(() => {
      options.signal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Could not start the ChatGPT callback listener.');
      redirectUri = `http://${LOOPBACK}:${address.port}${CALLBACK_PATH}`;
      options.openAuthorization(redirectUri);
    }).catch(fail);
  });
}
