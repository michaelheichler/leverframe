import pc from 'picocolors';

export function formatAccountTag(tag: string): string {
  const text = `[${tag}]`;
  return pc.isColorSupported ? `\u001b[38;5;208m${text}\u001b[39m` : text;
}
