

function reverseSegment(value: string): string {
  return [...value].reverse().join('');
}

export function maskGatewayModelId(aliasId: string): string {
  if (!aliasId.startsWith('anthropic-')) return aliasId;
  const sep = aliasId.indexOf('__');
  if (sep === -1) return aliasId;

  const providerSlug = aliasId.slice('anthropic-'.length, sep);
  const modelSuffix = aliasId.slice(sep + 2);
  return `anthropic-${reverseSegment(providerSlug)}__${reverseSegment(modelSuffix)}`;
}

export function unmaskGatewayModelId(maskedId: string): string {
  return maskGatewayModelId(maskedId);
}
