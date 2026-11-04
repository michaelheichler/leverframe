import type { IncomingMessage, ServerResponse } from 'node:http';
export { awaitRoutingNotice } from './routing-bindings.js';
export type { NoticeAcknowledgmentInput } from './routing-bindings.js';
import { extractApiKey, readBody, sendJson } from './http-utils.js';
import { createRoutingBinding, routingBindingEvents, type BindingLaunchInput, type RoutingSavedHandoff } from './routing-bindings.js';
import { routingPolicyIdentity } from './routing-policy-identity.js';
import { ROUTING_CONTROL_BODY_LIMIT, ROUTING_PREPARE_ACTION, ROUTING_LAUNCH_ACTION } from './constants.js';
import type { SelectorCallContext, SelectorDependencies, SelectorFeatures } from './routing-selector.js';
import type { RoutingWorkload } from './routing-estimate.js';
import { routingCategoryRequirements } from './routing-policy.js';
import { prepareRoutingHandoff, projectRoutingPromptPolicy, readRoutingHandoff, validateReviewedRoutingHandoff, type ModelRef } from './model-routing.js';
import type { RoutingNoticeChannel } from './routing-notice-channel.js';
import { createSelectorTrace, logSelectorOutcome } from './routing-selector-log.js';

export interface RoutingControlContext {
  proxyToken: string;
  recoveryOnly?: true;
  config: BindingLaunchInput['config'];
  catalog: BindingLaunchInput['catalog'];
  workload: BindingLaunchInput['workload'];
  selector?: BindingLaunchInput['selector'];
  selectorCache?: BindingLaunchInput['selectorCache'];
  selectorTransport?: SelectorDependencies['call'];
  selectorRequiresNotice?: boolean;
  inferenceLogPath?: string;
  routerTarget?: ModelRef;
  noticeChannel?: RoutingNoticeChannel;
  acceptNewBinding?: () => boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validNoticeSession(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !Array.from(value).some(char => { const code = char.charCodeAt(0); return code < 32 || code === 127; });
}

async function handleNoticeControlRequest(req: IncomingMessage, res: ServerResponse, context: RoutingControlContext, url: URL): Promise<void> {
  const channel = context.noticeChannel;
  if (!channel) { sendJson(res, 503, { error: { message: 'Routing notice channel is unavailable.' } }); return; }
  if (url.pathname === '/v1/leverframe/routing-events') {
    const sessionId = url.searchParams.get('sessionId');
    const cursor = url.searchParams.get('after');
    const consumerId = req.headers['x-leverframe-notice-consumer'];
    const after = cursor !== null && /^\d+$/.test(cursor) ? Number(cursor) : NaN;
    if (req.method !== 'GET' || !validNoticeSession(sessionId) || typeof consumerId !== 'string'
      || !Number.isSafeInteger(after) || after < 0 || [...url.searchParams.keys()].some(key => !['sessionId', 'after'].includes(key))
      || url.searchParams.getAll('sessionId').length !== 1 || url.searchParams.getAll('after').length !== 1) {
      sendJson(res, 400, { error: { message: 'Invalid routing event subscription.' } }); return;
    }
    if (!channel.connect(sessionId, consumerId, after, res)) sendJson(res, 409, { error: { message: 'Routing notice consumer is unavailable.' } });
    return;
  }
  if (req.method !== 'POST') { sendJson(res, 405, { error: { message: 'Only POST is supported.' } }); return; }
  try {
    const value = record(JSON.parse(await readBody(req, ROUTING_CONTROL_BODY_LIMIT)));
    if (!value || !validNoticeSession(value.sessionId)) throw new Error('Invalid routing notice request.');
    if (url.pathname === '/v1/leverframe/routing-notice-ready') {
      if (value.protocolVersion !== 1 || Object.keys(value).some(key => !['sessionId', 'protocolVersion', 'consumerId'].includes(key))
        || (value.consumerId !== undefined && (typeof value.consumerId !== 'string' || !value.consumerId))) {
        throw new Error('Invalid routing notice registration.');
      }
      if (typeof value.consumerId === 'string') {
        const renewed = channel.renew(value.sessionId, value.consumerId);
        if (!renewed) { sendJson(res, 409, { error: { message: 'Routing notice consumer is unavailable.' } }); return; }
        sendJson(res, 200, renewed);
      } else sendJson(res, 200, channel.register(value.sessionId));
      return;
    }
    if (Object.keys(value).some(key => !['sessionId', 'consumerId', 'sequence', 'modelId', 'revision'].includes(key))
      || typeof value.consumerId !== 'string' || typeof value.modelId !== 'string'
      || !Number.isSafeInteger(value.sequence) || !Number.isSafeInteger(value.revision)) throw new Error('Invalid routing notice acknowledgment.');
    const acknowledged = await channel.acknowledge({ sessionId: value.sessionId, consumerId: value.consumerId,
      modelId: value.modelId, sequence: value.sequence as number, revision: value.revision as number });
    if (!acknowledged) { sendJson(res, 409, { error: { message: 'Routing notice consumer is unavailable.' } }); return; }
    sendJson(res, 200, { acknowledged: true });
  } catch {
    sendJson(res, 400, { error: { message: 'Invalid routing notice request.' } });
  }
}

function completeWorkload(value: unknown): RoutingWorkload | undefined {
  const workload = record(value);
  if (!workload) return undefined;
  const keys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  if (Object.keys(workload).some(key => !keys.some(allowed => allowed === key))) return undefined;
  if (!keys.every(key => typeof workload[key] === 'number' && Number.isSafeInteger(workload[key])
    && (workload[key] as number) >= (key === 'output' ? 1 : 0) && (workload[key] as number) <= 1_000_000_000)) return undefined;
  return { input: workload.input as number, output: workload.output as number,
    cacheRead: workload.cacheRead as number, cacheWrite: workload.cacheWrite as number };
}

function selectorEvidence(value: unknown) {
  const evidence = record(value);
  const features = record(evidence?.features);
  const workload = completeWorkload(evidence?.workload);
  const selectorWorkload = completeWorkload(evidence?.selectorWorkload);
  if (!features || !workload || !selectorWorkload || !['small', 'medium', 'large'].includes(String(features.size))
    || !['few', 'many'].includes(String(features.turns)) || !['none', 'few', 'many'].includes(String(features.tools))
    || typeof features.recentFailures !== 'number' || !Number.isSafeInteger(features.recentFailures)
    || features.recentFailures < 0 || features.recentFailures > 1000) return undefined;
  return { features: { size: features.size, turns: features.turns, tools: features.tools,
    recentFailures: features.recentFailures } as SelectorFeatures, workload, selectorWorkload };
}

function validateRoutingLaunch(value: Record<string, unknown>, context: RoutingControlContext): RoutingSavedHandoff {
  if (context.recoveryOnly || context.config.enabled !== true) throw new Error('Routing is disabled for new launches.');
  if (value.role !== 'specialist' || value.resume !== false || typeof value.task !== 'string'
    || typeof value.originalPrompt !== 'string') throw new Error('Invalid routed handoff launch.');
  const handoff = record(value.handoff);
  if (!handoff || handoff.version !== 1 || Object.keys(handoff).some(key => !['version', 'originalTask',
    'requiredConstraints', 'toolInstructions', 'evidence', 'jobState'].includes(key))) throw new Error('Invalid routed handoff launch.');
  const policy = projectRoutingPromptPolicy(context.config);
  if (JSON.stringify(value.policy) !== JSON.stringify(policy)) throw new Error('Routing prompt policy changed. Refresh the integration.');
  const prepared = prepareRoutingHandoff({ policy, agentType: value.agentType as string,
    explicitCategory: value.category as string | undefined, delegatedTask: value.delegatedTask as string,
    originalTask: handoff.originalTask as string, requiredConstraints: handoff.requiredConstraints as string[],
    toolInstructions: handoff.toolInstructions as string[], evidence: handoff.evidence as { source: string; content: string }[],
    jobState: handoff.jobState as string });
  validateReviewedRoutingHandoff(prepared.envelope, value.originalPrompt);
  if (readRoutingHandoff(value.originalPrompt).additionalInstructions.length) throw new Error('Invalid original routing handoff.');
  validateReviewedRoutingHandoff(prepared.envelope, value.task);
  const reviewed = readRoutingHandoff(value.task);
  return { version: 1, agentType: reviewed.agentType, reviewedTask: value.task, prefix: reviewed.prefix,
    provenance: prepared.provenance as RoutingSavedHandoff['provenance'] };
}

function selectorForLaunch(context: RoutingControlContext, evidence: ReturnType<typeof selectorEvidence>, sessionId: string, launchId: string): BindingLaunchInput['selector'] {
  if (!evidence || !context.selectorTransport) return context.selector;
  let notice: SelectorCallContext | undefined;
  return { features: evidence.features, selectorWorkload: evidence.selectorWorkload,
    ...(context.selectorRequiresNotice ? { beforeCall: () => {
      notice = context.noticeChannel?.capture(sessionId);
      return !!notice;
    } } : {}),
    call: (target, payload, signal) => context.selectorTransport!(target, payload, signal, notice, createSelectorTrace(sessionId, launchId)) };
}

export async function handleRoutingControlRequest(req: IncomingMessage, res: ServerResponse, context: RoutingControlContext): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!['/v1/leverframe/routing-launch', '/v1/leverframe/routing-events', '/v1/leverframe/routing-notice-ready',
    '/v1/leverframe/routing-notice-ack'].includes(url.pathname)) return false;
  if (extractApiKey(req) !== context.proxyToken) {
    sendJson(res, 401, { error: { message: 'Invalid proxy token' } });
    return true;
  }
  if (url.pathname !== '/v1/leverframe/routing-launch') {
    await handleNoticeControlRequest(req, res, context, url);
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Only POST is supported.' } });
    return true;
  }
  try {
    const input: unknown = JSON.parse(await readBody(req, ROUTING_CONTROL_BODY_LIMIT));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid launch request.');
    const value = input as Record<string, unknown>;
    if (value.action === ROUTING_PREPARE_ACTION) {
      if (context.recoveryOnly || context.config.enabled !== true) throw new Error('Routing is disabled for new launches.');
      const policy = projectRoutingPromptPolicy(context.config);
      if (JSON.stringify(value.policy) !== JSON.stringify(policy)) throw new Error('Routing prompt policy changed. Refresh the integration.');
      const prepared = prepareRoutingHandoff({ policy, agentType: value.agentType as string,
        explicitCategory: value.category as string | undefined, delegatedTask: value.delegatedTask as string,
        originalTask: value.originalTask as string, requiredConstraints: value.requiredConstraints as string[],
        toolInstructions: value.toolInstructions as string[], evidence: value.evidence as { source: string; content: string }[],
        jobState: value.jobState as string });
      sendJson(res, 200, { prompt: JSON.stringify(prepared.envelope), provenance: prepared.provenance });
      return true;
    }
    let savedHandoff: RoutingSavedHandoff | undefined;
    let resolvedCategory = value.category as string | undefined;
    if (value.action === ROUTING_LAUNCH_ACTION) {
      savedHandoff = validateRoutingLaunch(value, context);
      resolvedCategory = savedHandoff.prefix.category;
    } else if (value.action !== undefined) throw new Error('Invalid routing control action.');
    else if (value.role !== 'specialist' || value.resume !== true) {
      throw new Error('A reviewed routing handoff is required. Refresh the integration.');
    }
    if (typeof value.sessionId !== 'string' || typeof value.launchId !== 'string'
      || (value.role !== 'router' && value.role !== 'specialist') || typeof value.task !== 'string'
      || (value.category !== undefined && typeof value.category !== 'string')
      || (value.agentType !== undefined && typeof value.agentType !== 'string')
      || (value.effort !== undefined && typeof value.effort !== 'string')
      || (value.resume !== undefined && typeof value.resume !== 'boolean')) throw new Error('Invalid launch request.');
    const evidence = value.selectorEvidence === undefined ? undefined : selectorEvidence(value.selectorEvidence);
    if (value.selectorEvidence !== undefined && !evidence) throw new Error('Invalid selector evidence.');
    const selector = selectorForLaunch(context, evidence, value.sessionId, value.launchId);
    const requirements = value.action === ROUTING_LAUNCH_ACTION && value.resume !== true
      ? routingCategoryRequirements(context.config, resolvedCategory) : undefined;
    const binding = await createRoutingBinding({ sessionId: value.sessionId, launchId: value.launchId, role: value.role,
      category: resolvedCategory, agentType: value.agentType as string | undefined, handoff: savedHandoff,
      effort: value.effort as string | undefined, task: value.task, resume: value.resume as boolean | undefined,
      config: context.config, catalog: context.catalog, requirements, workload: evidence?.workload ?? context.workload, selector,
      ...(requirements ? { requirementsFromConfig: true as const } : {}),
      selectorCache: context.selectorCache, acceptNewBinding: context.acceptNewBinding,
      selectorSkipReason: context.config.selector?.enabled && !selector ? routingBindingEvents.selectorMetadataUnavailable : undefined });
    logSelectorOutcome(context.inferenceLogPath, binding);
    if (value.action === undefined && (!binding.handoff || binding.handoff.agentType !== value.agentType)) {
      throw new Error('The saved routing handoff is unavailable. Start a new agent.');
    }
    const { policyModelId, contextWindow, metadata } = routingPolicyIdentity(context.catalog, binding.decision.target, binding.decision.effort, binding.requirements);
    if (policyModelId.startsWith('leverframe:') && (!metadata.contextWindow || !metadata.maxOutputTokens)) {
      throw new Error('Confirmed context and output limits are required for the routed model.');
    }
    sendJson(res, 200, { modelId: binding.modelId, policyModelId, effort: binding.decision.effort,
      contextWindow, maxOutputTokens: metadata.maxOutputTokens, revision: binding.revision,
      ...(value.resume === true ? { handoff: binding.handoff } : {}) });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'routing_launch_invalid';
    sendJson(res, code === 'routing_binding_pending' ? 409 : 400,
      { error: { code, message: error instanceof Error ? error.message : 'Routing launch failed.' } });
  }
  return true;
}
