import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';
import { once } from 'node:events';
import { startHttpProxy } from '../src/http-proxy/server.js';

const testHome = mkdtempSync(join(tmpdir(), 'leverframe-http-proxy-auth-'));
const previousRelayHome = process.env['LEVERFRAME_HOME'];

beforeAll(() => {
  process.env['LEVERFRAME_HOME'] = testHome;
});

afterAll(() => {
  if (previousRelayHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousRelayHome;
  rmSync(testHome, { recursive: true, force: true });
});

async function sendRaw(port: number, request: string): Promise<string> {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(request);
  const response = await new Promise<string>(resolve => {
    let buf = '';
    socket.on('data', chunk => { buf += chunk.toString(); });
    socket.setTimeout(3000, () => { socket.destroy(); resolve(buf); });
    socket.once('close', () => resolve(buf));
  });
  socket.destroy();
  return response;
}

describe('selective HTTP proxy Basic credential validation', () => {
  it('rejects valid-base64+garbage, bad alphabet, and bad padding on CONNECT and plain HTTP', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    const valid = Buffer.from(`leverframe:${proxy.token}`).toString('base64');
    const cases: Array<{ label: string; credential: string }> = [
      { label: 'valid+garbage', credential: valid + 'garbage' },
      { label: 'bad alphabet', credential: 'YWJj-ZGVm' },
      { label: 'bad padding', credential: 'Y2xvZGV4C===' },
    ];
    try {
      for (const item of cases) {
        const connectResp = await sendRaw(
          proxy.port,
          `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ${item.credential}\r\n\r\n`,
        );
        expect(connectResp.startsWith('HTTP/1.1 407'), `CONNECT ${item.label}`).toBe(true);

        const plainResp = await sendRaw(
          proxy.port,
          `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nProxy-Authorization: Basic ${item.credential}\r\n\r\n`,
        );
        expect(plainResp.startsWith('HTTP/1.1 407'), `plain HTTP ${item.label}`).toBe(true);
      }
    } finally {
      await proxy.close();
    }
  });

  it('accepts a canonical Basic credential on CONNECT', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    try {
      const valid = Buffer.from(`leverframe:${proxy.token}`).toString('base64');
      const response = await sendRaw(
        proxy.port,
        `CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ${valid}\r\n\r\n`,
      );
      expect(response.startsWith('HTTP/1.1 200 Connection Established')).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('accepts a canonical Basic credential on plain HTTP (no 407)', async () => {
    const proxy = await startHttpProxy({ routes: [] });
    try {
      const valid = Buffer.from(`leverframe:${proxy.token}`).toString('base64');
      const response = await sendRaw(
        proxy.port,
        `GET http://192.0.2.1:1/ HTTP/1.1\r\nHost: 192.0.2.1\r\nProxy-Authorization: Basic ${valid}\r\nConnection: close\r\n\r\n`,
      );
      expect(response.startsWith('HTTP/1.1 407')).toBe(false);
    } finally {
      await proxy.close();
    }
  });
});
