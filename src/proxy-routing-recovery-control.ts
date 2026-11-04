import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractApiKey, readBody, sendJson } from './http-utils.js';
import { assertRoutingIdentity, resolveRoutingRecovery } from './routing-bindings.js';
import { routingPolicyIdentity } from './routing-policy-identity.js';
import type { RoutingCatalogSnapshot } from './model-routing-catalog.js';

export async function handleRoutingRecoveryControlRequest(req: IncomingMessage, res: ServerResponse,
  context: { proxyToken: string; catalog: RoutingCatalogSnapshot }): Promise<boolean> {
  if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/v1/leverframe/routing-recovery') return false;
  if (extractApiKey(req) !== context.proxyToken) {
    sendJson(res, 401, { error: { message: 'Invalid proxy token' } });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Only POST is supported.' } });
    return true;
  }
  try {
    const input: unknown = JSON.parse(await readBody(req, 128 * 1024));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid recovery request.');
    const value = input as Record<string, unknown>;
    if (typeof value.sessionId !== 'string' || typeof value.launchId !== 'string' || value.sidecarValid !== true) {
      throw new Error('Invalid recovery request.');
    }
    const recovered = await resolveRoutingRecovery({ sessionId: value.sessionId, launchId: value.launchId,
      sidecarValid: true, marker: value.marker });
    if (recovered.kind === 'unbound') {
      sendJson(res, 200, { kind: 'unbound' });
      return true;
    }
    const binding = recovered.binding;
    if (!binding.handoff || typeof value.agentType !== 'string' || binding.handoff.agentType !== value.agentType) {
      throw new Error('The saved routing handoff is unavailable. Start a new agent.');
    }
    assertRoutingIdentity(binding, context.catalog);
    const { policyModelId, metadata } = routingPolicyIdentity(context.catalog, binding.decision.target, binding.decision.effort, binding.requirements);
    if (policyModelId.startsWith('leverframe:') && (!metadata.contextWindow || !metadata.maxOutputTokens)) {
      throw new Error('Confirmed context and output limits are required for the routed model.');
    }
    sendJson(res, 200, { kind: 'bound', modelId: binding.modelId, policyModelId, effort: binding.decision.effort,
      metadata, handoff: binding.handoff });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'routing_recovery_invalid';
    sendJson(res, 400, { error: { code, message: error instanceof Error ? error.message : 'Routing recovery failed.' } });
  }
  return true;
}
