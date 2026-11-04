import * as p from '@clack/prompts';
import { cachedSwitchyardCatalog, orderedSwitchyardModels } from './cli-switchyard-catalog.js';
import { refreshSwitchyardCatalog, runSwitchyardCommand } from './cli-command-switchyard.js';
import type { RoutingCatalogModel, RoutingCatalogSnapshot } from './model-routing-catalog.js';
import { loadPreferences } from './config.js';

const suggestions: Record<string, { terms: string[]; templateId?: string }> = {
  router: { terms: ['deepseek', 'flash'], templateId: 'opencode-go' },
  'router-fallback': { terms: ['haiku'] },
  orchestration: { terms: ['opus'] }, qa: { terms: ['opus'] },
  planning: { terms: ['sonnet'] }, coding: { terms: ['sol'] },
  summarization: { terms: ['gemini', 'flash'], templateId: 'antigravity' },
  exploration: { terms: ['gemini', 'flash'], templateId: 'antigravity' },
  research: { terms: ['deepseek', 'flash'], templateId: 'opencode-go' },
  deep_research: { terms: ['luna'] }, deep_research_second: { terms: ['sonnet'] },
};

function isSuggested(model: RoutingCatalogModel, category: string): boolean {
  const suggestion = Object.hasOwn(suggestions, category) ? suggestions[category] : undefined;
  if (!suggestion || !model.discovery.confirmed || model.discovery.state !== 'current'
    || (suggestion.templateId && model.templateId !== suggestion.templateId)) return false;
  const words = [model.ref.modelId, model.upstreamModelId, model.name, model.family]
    .flatMap(value => value?.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return suggestion.terms.every(term => words.includes(term));
}

async function chooseTarget(catalog?: RoutingCatalogSnapshot, category = ''): Promise<{ args: string[]; efforts: string[] } | undefined> {
  const rows = orderedSwitchyardModels(catalog ?? cachedSwitchyardCatalog());
  const unique = rows.filter((model, index) => rows.findIndex(other => other.ref.providerId === model.ref.providerId
    && other.ref.modelId === model.ref.modelId) === index);
  if (!unique.length) { p.log.warn('No cached models. Add a provider and run discovery.'); return undefined; }
  const suggested = new Set(rows.filter(model => isSuggested(model, category)).map(model => JSON.stringify(model.ref)));
  if (Object.hasOwn(suggestions, category) && !suggested.size) p.log.info(category === 'router'
    ? 'Preferred router family unresolved. Refresh discovery or choose a discovered Haiku in router fallback.'
    : 'Suggested family unresolved. Refresh discovery or choose another model.');
  const choice = await p.select({ message: 'Choose a target. Example cost uses one million input and one million output tokens.',
    options: unique.map((model, index) => ({ value: String(index), label: `${model.ref.providerId}/${model.ref.modelId}`,
      hint: `${suggested.has(JSON.stringify(model.ref)) ? 'suggested family, confirm version; ' : ''}${model.estimate.kind === 'known' ? `input ${model.estimate.input}, output ${model.estimate.output} USD per million tokens` : 'price unknown'}` })) });
  if (p.isCancel(choice)) return undefined;
  const model = unique[Number(choice)]!;
  return { args: ['--provider', model.ref.providerId, '--model', model.ref.modelId], efforts: model.supportedReasoningEfforts ?? [] };
}

async function chooseEffort(efforts: string[], required: boolean): Promise<string | undefined> {
  if (!efforts.length) { p.log.warn('No supported effort metadata is cached. Refresh discovery before choosing an effort.'); return undefined; }
  const choice = await p.select({ message: 'Supported effort', options: [
    ...(!required ? [{ value: '', label: 'Model default' }] : []),
    ...efforts.map(effort => ({ value: effort, label: effort })),
  ] });
  return p.isCancel(choice) ? undefined : choice;
}

async function configureTarget(category: string, catalog?: RoutingCatalogSnapshot): Promise<void> {
  const target = await chooseTarget(catalog, category);
  if (!target) return;
  if (category !== 'router' && category !== 'router-fallback' && target.efforts.length) {
    const effort = await chooseEffort(target.efforts, category === 'deep_research');
    if (effort === undefined) return;
    if (effort) target.args.push('--effort', effort);
  }
  if (category === 'deep_research') {
    if (!target.args.includes('--effort')) { p.log.error('Each research arm requires supported effort metadata.'); return; }
    const second = await chooseTarget(catalog, 'deep_research_second');
    if (!second) return;
    const effort = await chooseEffort(second.efforts, true);
    if (!effort) return;
    target.args.push(...second.args, '--effort', effort);
  }
  await runSwitchyardCommand(['set', category, ...target.args]);
}

export async function runSwitchyardMenu(): Promise<number> {
  let catalog: RoutingCatalogSnapshot | undefined;
  for (;;) {
    const choice = await p.select({ message: 'Switchyard', options: [
      { value: 'status', label: 'Status and accounts' }, { value: 'costs', label: 'Costs and provenance' },
      { value: 'refresh', label: 'Refresh model discovery' },
      { value: 'router', label: 'Configure preferred router' }, { value: 'router-fallback', label: 'Configure router fallback' },
      { value: 'category', label: 'Configure category' },
      { value: 'research', label: 'Configure two research arms' }, { value: 'billing', label: 'Billing preference' },
      { value: 'enable', label: 'Enable routing' }, { value: 'disable', label: 'Disable routing' },
      { value: 'done', label: 'Done' },
    ] });
    if (p.isCancel(choice) || choice === 'done') return 0;
    if (choice === 'refresh') {
      try { catalog = await refreshSwitchyardCatalog(); }
      catch (error) { p.log.error(error instanceof Error ? error.message : String(error)); }
    } else if (choice === 'router' || choice === 'router-fallback') await configureTarget(choice, catalog);
    else if (choice === 'research') await configureTarget('deep_research', catalog);
    else if (choice === 'category') {
      const names = [...new Set(['orchestration', 'planning', 'coding', 'qa', 'summarization', 'exploration', 'research',
        ...Object.keys(loadPreferences().routing?.categories ?? {}).filter(name => name !== 'deep_research')])];
      const category = await p.select({ message: 'Category', options: names.map(name => ({ value: name, label: name })) });
      if (!p.isCancel(category)) await configureTarget(category, catalog);
    } else if (choice === 'billing') {
      const preference = await p.select({ message: 'Billing preference', options: [
        { value: 'auto', label: 'Automatic' }, { value: 'subscription-first', label: 'Subscription first' },
        { value: 'api-first', label: 'API first' }, { value: 'balanced', label: 'Balanced' },
      ] });
      if (!p.isCancel(preference)) await runSwitchyardCommand(['billing', preference]);
    } else await runSwitchyardCommand([choice]);
  }
}
