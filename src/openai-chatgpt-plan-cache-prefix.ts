import { createHmac } from 'node:crypto';

const MAX_FINGERPRINTED_INPUT_ITEMS = 4096;

type CachePrefixFingerprint = {
  settings: string;
  tools: string;
  instructions: string;
  inputDigests: string[];
  inputItems: number;
};

export function fingerprintChatGptPlanPrefix(
  body: Record<string, unknown>,
  key: Uint8Array,
): CachePrefixFingerprint {
  const { input, tools, instructions, prompt_cache_options: options, ...settings } = body;
  const inputItems: unknown[] = Array.isArray(input) ? input : [];
  const firstNonDeveloper = inputItems.findIndex(item =>
    (item as { role?: string } | null)?.role !== 'developer');
  const developerItems = firstNonDeveloper < 0 ? inputItems : inputItems.slice(0, firstNonDeveloper);
  const cacheOptions = options && typeof options === 'object' ? { ...options } as Record<string, unknown> : {};
  delete cacheOptions['comparison_response_id'];
  const digest = (value: unknown): string => createHmac('sha256', key).update(JSON.stringify(value) ?? '').digest('hex');
  const sortedSettings = Object.keys(settings).sort().map(name => [name, settings[name]]);
  return {
    settings: digest([sortedSettings, Object.keys(cacheOptions).sort().map(name => [name, cacheOptions[name]])]),
    tools: digest(tools),
    instructions: digest([instructions, developerItems]),
    inputDigests: inputItems.slice(0, MAX_FINGERPRINTED_INPUT_ITEMS).map(digest),
    inputItems: inputItems.length,
  };
}

function firstChangedSection(previous: CachePrefixFingerprint, current: CachePrefixFingerprint, sharedItems: number) {
  if (previous.settings !== current.settings) return 'settings';
  if (previous.tools !== current.tools) return 'tools';
  if (previous.instructions !== current.instructions) return 'instructions';
  if (sharedItems === previous.inputItems) return 'none';
  if (sharedItems === MAX_FINGERPRINTED_INPUT_ITEMS && current.inputItems > sharedItems) return 'unknown';
  return 'input';
}

export function compareChatGptPlanPrefixes(previous: CachePrefixFingerprint, current: CachePrefixFingerprint) {
  let sharedInputItems = 0;
  for (const digest of previous.inputDigests) {
    if (digest !== current.inputDigests[sharedInputItems]) break;
    sharedInputItems++;
  }
  return {
    firstChangedSection: firstChangedSection(previous, current, sharedInputItems),
    sharedInputItems,
    previousInputItems: previous.inputItems,
    inputItems: current.inputItems,
  };
}
