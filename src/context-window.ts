export function reportedContextWindow(
  explicit?: number,
  unconfirmed?: boolean,
): number | undefined {
  if (unconfirmed === true) return undefined;
  if (typeof explicit !== 'number' || !Number.isSafeInteger(explicit) || explicit <= 0) return undefined;
  return explicit;
}

export function resolveContextWindow(
  _modelId: string,
  explicit?: number,
  unconfirmed?: boolean,
): number | undefined {
  return reportedContextWindow(explicit, unconfirmed);
}
