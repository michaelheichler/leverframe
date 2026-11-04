import { ROUTING_LAUNCH_ACTION, ROUTING_PREPARE_ACTION } from '../../src/constants.js';
import { projectRoutingPromptPolicy } from '../../src/model-routing.js';
import type { RoutingControlContext } from '../../src/proxy-routing-control.js';

export interface RoutedControlLaunchInput {
  sessionId: string;
  launchId: string;
  agentType: string;
  category: string;
  task: string;
  effort?: string;
  clientConfig?: unknown;
  selectorEvidence?: unknown;
}

async function post(endpoint: string, proxyToken: string, body: Record<string, unknown>) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxyToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export async function prepareAndLaunch(endpoint: string, context: RoutingControlContext, input: RoutedControlLaunchInput) {
  const policy = projectRoutingPromptPolicy(context.config);
  const evidence: { source: string; content: string }[] = [];
  const requiredConstraints: string[] = [];
  const toolInstructions: string[] = [];
  const jobState = '';
  const preparation = await post(endpoint, context.proxyToken, {
    action: ROUTING_PREPARE_ACTION,
    version: 1,
    policy,
    agentType: input.agentType,
    category: input.category,
    delegatedTask: input.task,
    originalTask: input.task,
    requiredConstraints,
    toolInstructions,
    evidence,
    jobState,
  });
  const originalPrompt = preparation.body['prompt'];
  const handoff = { version: 1, originalTask: input.task, requiredConstraints, toolInstructions, evidence, jobState };
  const launch = await post(endpoint, context.proxyToken, {
    action: ROUTING_LAUNCH_ACTION,
    sessionId: input.sessionId,
    launchId: input.launchId,
    role: 'specialist',
    agentType: input.agentType,
    category: input.category,
    effort: input.effort,
    task: originalPrompt,
    resume: false,
    originalPrompt,
    delegatedTask: input.task,
    handoff,
    policy,
    ...(input.clientConfig === undefined ? {} : { config: input.clientConfig }),
    ...(input.selectorEvidence === undefined ? {} : { selectorEvidence: input.selectorEvidence }),
  });
  return { preparation, launch };
}
