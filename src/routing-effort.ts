export function applyRoutingEffort(body: Record<string, unknown>, effort: string | undefined): void {
  const output = body.output_config;
  const record = output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown> : undefined;
  if (effort !== undefined) {
    body.output_config = { ...record, effort };
    return;
  }
  if (!record || !Object.hasOwn(record, 'effort')) return;
  const updated = { ...record };
  delete updated.effort;
  if (Object.keys(updated).length) body.output_config = updated;
  else delete body.output_config;
}
