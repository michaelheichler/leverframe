import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from '../http-utils.js';
import { isLocalHostRequestAllowed } from '../server/auth.js';
import { openEvidenceStore } from './evidence-runtime.js';

export async function handleEvidenceRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const peer = req.socket.remoteAddress;
  if (!isLocalHostRequestAllowed(req) || (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1')) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  try {
    const raw = await readBody(req, 4096);
    const value: unknown = JSON.parse(raw.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('sessionId' in value) || !('reference' in value) || typeof value.sessionId !== 'string' || typeof value.reference !== 'string') throw new Error('invalid request');
    const content = await (await openEvidenceStore()).get(value.sessionId, value.reference);
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { content });
  } catch {
    sendJson(res, 404, { error: 'Evidence unavailable' });
  }
}
