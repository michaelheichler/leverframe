export function upstreamResponsesStream(text = 'fixture response', terminalEvent = true): Response {
  const item = {
    id: 'message-id', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'response-id', status: 'completed', output: [item],
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 },
  };
  const events = [
    { type: 'response.created', response: { id: response.id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    ...(terminalEvent ? [
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ] : []),
  ];
  const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
}
