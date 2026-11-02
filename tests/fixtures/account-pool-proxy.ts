import { once } from 'node:events';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';

export interface UpstreamCall {
  key: string | undefined;
  model: string;
}

export interface OpenAiUpstreamCall {
  authorization: string | undefined;
  accountId: string | undefined;
  model: string;
  path: string;
}

export async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local upstream did not bind');
  return address.port;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export function messageResponse(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  response.end(JSON.stringify({
    id: 'message-fixture', type: 'message', role: 'assistant', model: 'claude-native-fixture',
    content: [{ type: 'text', text: 'alternate account response' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 4, output_tokens: 3 },
  }));
}

export function quotaResponse(response: ServerResponse, resetAt: string | null = new Date(Date.now() + 60_000).toISOString()): void {
  response.writeHead(429, {
    'Content-Type': 'application/json',
    'anthropic-ratelimit-requests-remaining': '0',
    ...(resetAt === null ? {} : { 'anthropic-ratelimit-requests-reset': resetAt }),
  });
  response.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }));
}

export async function startNativeUpstream(
  respond: (call: UpstreamCall, response: ServerResponse) => void | Promise<void>,
): Promise<{ port: number; calls: UpstreamCall[]; close: () => Promise<void> }> {
  const calls: UpstreamCall[] = [];
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model: string };
    const key = request.headers['x-api-key'];
    const call = { key: Array.isArray(key) ? key[0] : key, model: body.model };
    calls.push(call);
    await respond(call, response);
  });
  const port = await listen(server);
  return {
    port,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

export function openAiSuccessResponse(
  response: ServerResponse,
  headers: Record<string, string> = {},
  events: object[] = [],
): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
  response.end([
    'data: {"type":"response.created","response":{"id":"response-fixture","created_at":1,"model":"gpt-4o-mini"}}',
    '',
    ...events.flatMap(event => [`data: ${JSON.stringify(event)}`, '']),
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"message-fixture"}}',
    '',
    'data: {"type":"response.output_text.delta","item_id":"message-fixture","delta":"OAuth fixture response"}',
    '',
    'data: {"type":"response.completed","response":{"id":"response-fixture","usage":{"input_tokens":4,"output_tokens":3}}}',
    '',
    '',
  ].join('\n'));
}

export async function startOpenAiUpstream(
  respond: (call: OpenAiUpstreamCall, response: ServerResponse) => void = (_call, response) => openAiSuccessResponse(response),
): Promise<{ port: number; calls: OpenAiUpstreamCall[]; close: () => Promise<void> }> {
  const calls: OpenAiUpstreamCall[] = [];
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { model: string };
    const accountHeader = request.headers['chatgpt-account-id'];
    const call = {
      authorization: request.headers.authorization,
      accountId: Array.isArray(accountHeader) ? accountHeader[0] : accountHeader,
      model: body.model,
      path: request.url ?? '',
    };
    calls.push(call);
    respond(call, response);
  });
  const port = await listen(server);
  return {
    port,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

export async function forwardSdkFetchToLocal(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  port: number,
): Promise<Response> {
  const sourceRequest = input instanceof Request ? input : undefined;
  const url = new URL(sourceRequest?.url ?? String(input));
  if (!['chatgpt.com', 'api.openai.com'].includes(url.hostname)) {
    throw new Error(`Unexpected non-OpenAI request in local fixture: ${url.hostname}`);
  }
  const headers = new Headers(init?.headers ?? sourceRequest?.headers);
  const sourceBody = init?.body ?? (sourceRequest ? sourceRequest.clone().body : undefined);
  const body = sourceBody === undefined || sourceBody === null
    ? undefined
    : Buffer.from(await new Response(sourceBody as BodyInit).arrayBuffer());

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: url.pathname + url.search,
      method: init?.method ?? sourceRequest?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
    }, response => {
      const bodyStream = new ReadableStream<Uint8Array>({
        start(controller) {
          response.on('data', chunk => controller.enqueue(Buffer.from(chunk)));
          response.on('end', () => controller.close());
          response.on('error', error => controller.error(error));
        },
        cancel() {
          response.destroy();
        },
      });
      resolve(new Response(bodyStream, {
        status: response.statusCode ?? 200,
        headers: {
          'Content-Type': response.headers['content-type'] ?? 'application/json',
          ...Object.fromEntries(Object.entries(response.headers)
            .filter(([name, value]) => name.startsWith('x-codex-') && typeof value === 'string')),
        },
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

export async function connectMitm(proxyPort: number, token: string, ca: string): Promise<tls.TLSSocket> {
  const socket = net.connect(proxyPort, '127.0.0.1');
  await once(socket, 'connect');
  socket.write([
    'CONNECT api.anthropic.com:443 HTTP/1.1',
    'Host: api.anthropic.com:443',
    `Proxy-Authorization: Basic ${Buffer.from(`leverframe:${token}`).toString('base64')}`,
    '',
    '',
  ].join('\r\n'));

  let headers = Buffer.alloc(0);
  while (!headers.includes(Buffer.from('\r\n\r\n'))) {
    const [chunk] = await once(socket, 'data') as [Buffer];
    headers = Buffer.concat([headers, chunk]);
  }
  const split = headers.indexOf('\r\n\r\n') + 4;
  if (!headers.subarray(0, split).toString('utf8').includes('200 Connection Established')) {
    throw new Error('HTTP proxy did not establish the local TLS tunnel');
  }
  const remaining = headers.subarray(split);
  if (remaining.length > 0) socket.unshift(remaining);
  const secure = tls.connect({ socket, servername: 'api.anthropic.com', ca });
  await once(secure, 'secureConnect');
  return secure;
}

export function sendMitmMessages(socket: tls.TLSSocket, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model, max_tokens: 20, messages: [{ role: 'user', content: 'fixture request' }], stream: false,
    });
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.write([
      'POST /v1/messages HTTP/1.1',
      'Host: api.anthropic.com',
      'X-API-Key: client-placeholder-key',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n') + body);
  });
}

export function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), 10_000)),
  ]);
}
