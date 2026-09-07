export type ContextSelectionMode = 'default' | 'maximum';

export interface ContextSelectionMetadata {
  contextWindow?: number;
  maxContextWindow?: number;
  contextWindowUnconfirmed?: boolean;
}

export interface ContextSelectionOption {
  mode: ContextSelectionMode;
  contextWindow: number;
  label: string;
}

export class ContextSelectionUnavailableError extends Error {
  constructor(message = 'No confirmed context window is available for this model.') {
    super(message);
    this.name = 'ContextSelectionUnavailableError';
  }
}

function positiveTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function compactTokenCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatContextSelectionLabel(mode: ContextSelectionMode, contextWindow: number): string {
  const title = mode === 'maximum' ? 'Maximum' : 'Default';
  return `${title} (${compactTokenCount(contextWindow)})`;
}

export function contextSelectionOptions(
  metadata: ContextSelectionMetadata,
): ContextSelectionOption[] {
  if (metadata.contextWindowUnconfirmed === true) return [];
  const contextWindow = positiveTokenCount(metadata.contextWindow);
  if (contextWindow === undefined) return [];

  const options: ContextSelectionOption[] = [{
    mode: 'default',
    contextWindow,
    label: formatContextSelectionLabel('default', contextWindow),
  }];
  const maximum = positiveTokenCount(metadata.maxContextWindow);
  if (maximum !== undefined && maximum > contextWindow) {
    options.push({
      mode: 'maximum',
      contextWindow: maximum,
      label: formatContextSelectionLabel('maximum', maximum),
    });
  }
  return options;
}

export function resolveContextSelection(
  metadata: ContextSelectionMetadata,
  mode: ContextSelectionMode = 'default',
): ContextSelectionOption {
  const option = contextSelectionOptions(metadata).find(candidate => candidate.mode === mode);
  if (option) return option;
  if (mode === 'maximum') {
    throw new ContextSelectionUnavailableError(
      'Maximum context is unavailable because fresh provider metadata did not report a larger confirmed limit.',
    );
  }
  throw new ContextSelectionUnavailableError();
}
