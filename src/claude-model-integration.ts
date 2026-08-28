import {
  applyLeverframePatches,
  PatchApplyError,
  type ApplyPatchesOutcome,
  type PatchScriptModelConfig,
  type PatchSiteResult,
} from './patch-transforms.js';

export interface ClaudeJavaScriptModule {
  name: string;
  content: string;
}

export interface ClaudeModuleIntegrationOutcome extends ApplyPatchesOutcome {
  modules: ClaudeJavaScriptModule[];
  changedModules: string[];
}

const MODULE_BOUNDARY = '\n/*__LEVERFRAME_CLAUDE_MODULE_BOUNDARY__*/\n';

const CAPABILITY_NAMES: Record<string, string> = {
  '1': 'agent-model-schema',
  '3': 'known-model-identities',
  '4': 'agent-model-description',
  '5': 'model-picker',
  '6': 'model-alias-resolution',
  '7': 'context-window',
  '8a': 'effort',
  '8b': 'xhigh-effort',
  '8c': 'max-effort',
  '9': 'default-effort',
  '10': 'routing-notice',
  '10a': 'routing-notice',
  '10b': 'routing-notice',
  '10c': 'routing-notice',
  '10d': 'agent-row-display',
  '11': 'session-restore',
};

export class ClaudeIntegrationCompatibilityError extends Error {
  constructor(readonly results: PatchSiteResult[], routingRequired = false) {
    const failed = results.filter(result => isIncompatible(result, routingRequired));
    super(`Claude model integration is structurally incompatible: ${failed.map(result => result.name).join(', ')}`);
    this.name = 'ClaudeIntegrationCompatibilityError';
  }
}

function isIncompatible(result: PatchSiteResult, routingRequired: boolean): boolean {
  return result.status === 'FAIL' || (
    routingRequired
    && (result.name === 'routing-notice' || result.name === 'agent-row-display')
    && result.status === 'SKIP'
    && /anchor not recognized|could not be patched|ambiguous/i.test(result.extra ?? '')
  );
}

function capabilityResults(results: PatchSiteResult[]): PatchSiteResult[] {
  return results.map(result => {
    const match = /^PATCH ([0-9]+[a-z]?):/.exec(result.name);
    const name = match ? CAPABILITY_NAMES[match[1]!] ?? result.name.replace(/^PATCH [^:]+:\s*/, '') : result.name;
    return { ...result, name };
  });
}

export function applyLeverframeIntegration(source: string, config: PatchScriptModelConfig): ApplyPatchesOutcome {
  const routingRequired = source.includes('async call({prompt:') && source.includes('agentLifecycle.markTypeInvoked');
  let patched: ApplyPatchesOutcome;
  try {
    patched = applyLeverframePatches(source, config);
  } catch (error) {
    if (error instanceof PatchApplyError) throw new ClaudeIntegrationCompatibilityError(capabilityResults(error.results), routingRequired);
    throw error;
  }
  const results = capabilityResults(patched.results);
  const incompatible = results.some(result => isIncompatible(result, routingRequired));
  if (incompatible) throw new ClaudeIntegrationCompatibilityError(results, routingRequired);
  return { content: patched.content, results };
}

export function applyLeverframeIntegrationToModules(
  modules: readonly ClaudeJavaScriptModule[],
  config: PatchScriptModelConfig,
): ClaudeModuleIntegrationOutcome {
  if (modules.length === 0) throw new Error('Claude bundle contains no JavaScript modules');
  for (const module of modules) {
    if (module.content.includes(MODULE_BOUNDARY)) {
      throw new Error(`Claude module ${module.name} contains the reserved integration boundary`);
    }
  }

  const source = modules.map(module => module.content).join(MODULE_BOUNDARY);
  const patched = applyLeverframeIntegration(source, config);
  const contents = patched.content.split(MODULE_BOUNDARY);
  if (contents.length !== modules.length) {
    throw new Error('Claude integration changed the module graph boundary');
  }

  const changedModules: string[] = [];
  const integratedModules = modules.map((module, index) => {
    const content = contents[index]!;
    if (content !== module.content) changedModules.push(module.name);
    return content === module.content ? module : { ...module, content };
  });

  return {
    ...patched,
    content: patched.content,
    modules: integratedModules,
    changedModules,
  };
}
