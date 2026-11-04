import { httpProxyModelId } from './http-proxy/routes.js';
import type { ModelRef, RoutingConfig } from './model-routing.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';
import { decideRouting, eligible, sameRef, type RoutingRequirements } from './routing-policy.js';

export const routingIdentityErrors = {
  unavailable: 'routing_identity_unavailable',
  conflict: 'routing_identity_conflict',
} as const;

export function routingPolicyIdentity(catalog: RoutingCatalogSnapshot, target: ModelRef, effort?: string, requirements?: RoutingRequirements) {
  const models = catalog.models.filter(model => sameRef(model.ref, target) && eligible(model, effort, requirements));
  if (!models.length || models.some(model => !model.upstreamModelId?.trim() || typeof model.transportFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(model.transportFingerprint))) {
    throw Object.assign(new Error('The selected routing model identity is unavailable. Refresh provider discovery.'), { code: routingIdentityErrors.unavailable });
  }
  const first = models[0]!;
  if (models.some(model => model.upstreamModelId !== first.upstreamModelId || model.credential.source !== first.credential.source
    || model.transportFingerprint !== first.transportFingerprint)) {
    throw Object.assign(new Error('Eligible accounts disagree on the selected routing model identity.'), { code: routingIdentityErrors.conflict });
  }
  const contextWindow = models.every(model => model.contextWindowConfirmed && model.contextWindow !== undefined)
    ? Math.min(...models.map(model => model.contextWindow!)) : undefined;
  const maxOutputTokens = models.every(model => Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens! > 0)
    ? Math.min(...models.map(model => model.maxOutputTokens!)) : undefined;
  const supportedReasoningEfforts = models.every(model => Array.isArray(model.supportedReasoningEfforts))
    ? first.supportedReasoningEfforts!.filter(value => models.every(model => model.supportedReasoningEfforts!.includes(value)))
    : undefined;
  return { policyModelId: first.credential.source === 'claude-code' ? first.upstreamModelId!
    : httpProxyModelId(target.providerId, target.modelId), contextWindow,
    metadata: { contextWindow, maxOutputTokens, supportedReasoningEfforts },
    identity: { upstreamModelId: first.upstreamModelId!, credentialSource: first.credential.source, transportFingerprint: first.transportFingerprint! },
    accountIds: models.map(model => model.accountId).filter((id): id is string => !!id) };
}

export function routingPreflight(config: RoutingConfig, catalog: RoutingCatalogSnapshot, recoveredTargets: ModelRef[] = []) {
  const decision = decideRouting({ config, catalog, role: 'router', workload: {} });
  const front = routingPolicyIdentity(catalog, decision.target, decision.effort);
  const targetMetadata: Record<string, typeof front.metadata> = Object.create(null);
  const refs = [config.cheapFloor, config.cheapFallback, ...(config.routerFallbacks ?? []), ...(config.pool ?? []),
    ...Object.values(config.categories ?? {}).flatMap(category =>
      [category.target, ...(category.alternatingTargets ?? []), ...(category.servingAlternatives ?? []), ...(category.fallbacks ?? [])]), ...recoveredTargets];
  for (const ref of refs) {
    if (!ref || !catalog.models.some(model => sameRef(model.ref, ref) && eligible(model, undefined, undefined))) continue;
    let target: ReturnType<typeof routingPolicyIdentity>;
    try { target = routingPolicyIdentity(catalog, ref); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === routingIdentityErrors.unavailable) continue;
      throw error;
    }
    const rows = catalog.models.filter(model => sameRef(model.ref, ref) && eligible(model, undefined, undefined));
    const knownEfforts = rows.flatMap(model => model.supportedReasoningEfforts ?? []);
    const metadata = { ...target.metadata, supportedReasoningEfforts: rows.some(model => Array.isArray(model.supportedReasoningEfforts))
      ? [...new Set(knownEfforts)].sort() : undefined };
    const previous = targetMetadata[target.policyModelId];
    if (previous && JSON.stringify(previous) !== JSON.stringify(metadata)) {
      throw Object.assign(new Error('Routing models disagree on confirmed metadata.'), { code: routingIdentityErrors.conflict });
    }
    targetMetadata[target.policyModelId] = metadata;
  }
  return { target: decision.target, ...front, targetMetadata };
}
