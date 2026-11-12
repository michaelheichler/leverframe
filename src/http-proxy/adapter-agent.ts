import { Agent, type AgentOptions, type ClientRequest, type RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import { createConnectionNotice } from './connection-notice.js';

type AddRequest = (this: Agent, request: ClientRequest, options: RequestOptions) => void;
const addNativeRequest = Reflect.get(Agent.prototype, 'addRequest') as AddRequest;

export const ADAPTER_MAX_SOCKETS = 64;
export const ADAPTER_MAX_FREE_SOCKETS = 8;
export const ADAPTER_IDLE_TIMEOUT_MS = 30_000;

interface AdapterAgentOptions {
  maxSockets?: number;
  maxFreeSockets?: number;
  idleTimeoutMs?: number;
}

class IdleAdapterAgent extends Agent {
  private readonly reportQueue = createConnectionNotice('Leverframe adapter connection cap reached, requests are queued.');

  addRequest(request: ClientRequest, options: RequestOptions): void {
    addNativeRequest.call(this, request, options);
    if (Object.values(this.requests).some(queued => queued?.includes(request))) this.reportQueue();
  }

  constructor(options: AgentOptions, private readonly idleTimeoutMs: number) {
    super(options);
  }

  override keepSocketAlive(socket: Socket): boolean {
    const reusable: unknown = super.keepSocketAlive(socket);
    if (reusable === false) return false;
    socket.setTimeout(Math.min(socket.timeout || this.idleTimeoutMs, this.idleTimeoutMs));
    return true;
  }

  override reuseSocket(socket: Socket, request: ClientRequest): void {
    super.reuseSocket(socket, request);
    socket.setTimeout(0);
  }
}

function positiveBudget(value: number | undefined, fallback: number): number {
  const budget = value ?? fallback;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new RangeError('Adapter pool budgets must be positive safe integers.');
  }
  return budget;
}

export function createAdapterAgent(options: AdapterAgentOptions = {}): Agent {
  const maxSockets = positiveBudget(options.maxSockets, ADAPTER_MAX_SOCKETS);
  const maxFreeSockets = Math.min(positiveBudget(options.maxFreeSockets, ADAPTER_MAX_FREE_SOCKETS), maxSockets);
  const idleTimeoutMs = positiveBudget(options.idleTimeoutMs, ADAPTER_IDLE_TIMEOUT_MS);
  return new IdleAdapterAgent({ keepAlive: true, maxSockets, maxTotalSockets: maxSockets, maxFreeSockets }, idleTimeoutMs);
}
