import type { ModelCost } from '../types.js';

export interface SupplierModelMetadata {
  npm?: string;
  usageMultiplier?: number;
  cost?: ModelCost;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim().replaceAll('`', ''));
}

function amount(value: string): number | undefined {
  const match = value.match(/\$([\d.]+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function modelNameKey(value: string): string {
  return value
    .replace(/\([^)]*tokens?\)/gi, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

export function parseOpenCodeGoMetadata(mdx: string): Map<string, SupplierModelMetadata> {
  const monthlyMatch = mdx.match(/\*\*\$([\d.]+)\/month\*\*/gi)?.at(-1)?.match(/\$([\d.]+)/);
  const monthlyPrice = monthlyMatch ? Number(monthlyMatch[1]) : NaN;
  const pricingByName = new Map<string, { usage?: number; cost?: ModelCost }>();
  const endpointRows: Array<{ name: string; id: string; npm: string }> = [];

  for (const line of mdx.split(/\r?\n/)) {
    if (!line.trim().startsWith('|') || /^\|\s*-+/.test(line)) continue;
    const cells = tableCells(line);
    if (cells.length === 6 && cells[0] !== 'Model') {
      const input = amount(cells[1] ?? '');
      const output = amount(cells[2] ?? '');
      const usage = amount(cells[5] ?? '');
      const cacheRead = amount(cells[3] ?? '');
      const cacheWrite = amount(cells[4] ?? '');
      const cost = input === undefined && output === undefined
        ? undefined
        : {
            input: input ?? 0,
            output: output ?? 0,
            ...(cacheRead === undefined ? {} : { cache_read: cacheRead }),
            ...(cacheWrite === undefined ? {} : { cache_write: cacheWrite }),
          };
      const key = modelNameKey(cells[0] ?? '');
      if (key && !pricingByName.has(key)) pricingByName.set(key, { usage, cost });
    }
    if (cells.length === 4 && cells[0] !== 'Model') {
      const [name, id, , npm] = cells;
      if (name && id && npm?.startsWith('@ai-sdk/')) endpointRows.push({ name, id, npm });
    }
  }

  return new Map(endpointRows.map(row => {
    const pricing = pricingByName.get(modelNameKey(row.name));
    const usageMultiplier = pricing?.usage !== undefined && Number.isFinite(monthlyPrice) && monthlyPrice > 0
      ? pricing.usage / monthlyPrice
      : undefined;
    return [row.id, {
      npm: row.npm,
      usageMultiplier,
      cost: pricing?.cost,
    }];
  }));
}

export async function fetchOpenCodeGoMetadata(url: string): Promise<Map<string, SupplierModelMetadata> | null> {
  try {
    const response = await fetch(url, { headers: { Accept: 'text/plain' } });
    if (!response.ok) return null;
    return parseOpenCodeGoMetadata(await response.text());
  } catch {
    return null;
  }
}
