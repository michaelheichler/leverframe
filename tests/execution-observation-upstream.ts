import { createServer } from 'node:http';

export async function createObservationUpstream(mode: string) {
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mode === 'openai'
      ? { choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'read' } }] } }] }
      : { content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: {} }] }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  return { upstream, baseUrl: `http://127.0.0.1:${address.port}` };
}
