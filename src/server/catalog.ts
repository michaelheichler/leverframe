import pc from 'picocolors';
import { fetchFreshProviderCatalog, localProvidersToServerModels } from '../provider-catalog.js';
import { getReasoningCapabilities } from '../provider-factory.js';
import { providersForTarget } from '../target-compatibility.js';
import type { LocalProvider } from '../types.js';
import {
  buildDedupedModelRows,
  gatewayProviderLabel,
  upstreamModelId,
  type GatewayModelOptions,
  type ServerModelInfo,
} from './models.js';
import type { ServerProviderOption } from './provider-select.js';

function displayValue(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, Math.max(0, cap - 1))}…`;
}

function cappedWidth(values: string[], label: string, cap: number): number {
  return Math.max(label.length, ...values.map(value => displayValue(value, cap).length));
}

export function formatModelCatalogLines(models: ServerModelInfo[], gateway?: GatewayModelOptions): string[] {
  if (models.length === 0) return [];

  const groups = new Map<string, ServerModelInfo[]>();
  for (const model of models) {
    const label = gatewayProviderLabel(model);
    let list = groups.get(label);
    if (!list) {
      list = [];
      groups.set(label, list);
    }
    list.push(model);
  }

  const lines: string[] = ['Model catalog:', ''];
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [label, groupModels] of sortedGroups) {
    const rows = buildDedupedModelRows(groupModels, gateway);
    const hiddenDuplicates = groupModels.length - rows.length;
    const duplicateNote = hiddenDuplicates > 0 ? `, ${hiddenDuplicates} duplicate${hiddenDuplicates !== 1 ? 's' : ''} hidden` : '';
    const nameWidth = cappedWidth(rows.map(row => row.name), 'Model', 28);
    const anthropicWidth = cappedWidth(rows.map(row => row.anthropicId), 'Anthropic ID', 46);
    const indexWidth = Math.max(String(rows.length).length, 1);

    lines.push(`  ${label} (${rows.length}${duplicateNote})`);
    lines.push(`  ${'#'.padStart(indexWidth)}  ${'Model'.padEnd(nameWidth)}  ${'Anthropic ID'.padEnd(anthropicWidth)}  OpenAI ID`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const name = displayValue(row.name, 28);
      const anthropicId = displayValue(row.anthropicId, 46);
      lines.push(`  ${String(i + 1).padStart(indexWidth)}  ${name.padEnd(nameWidth)}  ${anthropicId.padEnd(anthropicWidth)}  ${row.openaiId}`);
    }
    lines.push('');
  }
  return lines;
}

export function printModelCatalog(models: ServerModelInfo[], gateway?: GatewayModelOptions): void {
  if (models.length === 0) return;

  for (const line of formatModelCatalogLines(models, gateway)) {
    if (line === 'Model catalog:') {
      console.log(pc.bold(line));
    } else if (/^  [^#\d\s].+\(\d+/.test(line)) {
      console.log(pc.bold(line));
    } else if (/^  \s*#\s+Model\s+Anthropic ID\s+OpenAI ID/.test(line)) {
      console.log(pc.dim(line));
    } else {
      console.log(line);
    }
  }
}

export function providerOptionsFromCatalog(catalog: LocalProvider[]): ServerProviderOption[] {
  const options: ServerProviderOption[] = [];
  for (const provider of providersForTarget(catalog, 'server')) {
    options.push({
      id: provider.id,
      name: provider.name,
      modelCount: provider.models.length,
    });
  }
  return options;
}

export async function loadServerModels(): Promise<ServerModelInfo[]> {
  const { providers: catalog } = await fetchFreshProviderCatalog({ agent: 'server' });
  const models: ServerModelInfo[] = [];

  const serverProviders = providersForTarget(catalog, 'server');
  if (serverProviders.length > 0) {
    models.push(...localProvidersToServerModels(serverProviders));
  }

  return models.map(enrichServerModelReasoning);
}

export function enrichServerModelReasoning(model: ServerModelInfo): ServerModelInfo {
  if (!model.npm || model.modelFormat !== 'openai') return model;
  const caps = getReasoningCapabilities(model.npm, upstreamModelId(model), {
    providerId: model.providerId,
    apiBaseUrl: model.apiBaseUrl,
    supportedParameters: model.supportedParameters,
    reasoning: model.reasoning,
    supportsTemperature: model.supportsTemperature,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportsReasoningSummaries: model.supportsReasoningSummaries,
    supportsReasoningSummaryParameter: model.supportsReasoningSummaryParameter,
    supportsParallelToolCalls: model.supportsParallelToolCalls,
    supportsReasoningToggle: model.supportsReasoningToggle,
    supportsPromptCacheBreakpoints: model.supportsPromptCacheBreakpoints,
    useResponsesLite: model.useResponsesLite,
    interleavedReasoningField: model.interleavedReasoningField,
  });
  if (!caps.defaultLevel) return model;
  return { ...model, defaultEffort: caps.defaultLevel };
}
