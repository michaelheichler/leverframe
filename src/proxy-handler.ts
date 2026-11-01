import type { LanguageModel } from 'ai';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  anthropicMessagesEndpoint
} from './anthropic-endpoints.js';
import { ProviderRuntimeCache } from './provider-runtime-cache.js';
import { handleContextSelectionRequest } from './proxy-context-selection.js';
import { handleProxyMessages } from './proxy-messages-handler.js';
import {
  lookupRoute,
  type ProxyRoute
} from './proxy-request.js';
import {
  anthropicError,
  makeProxyLog
} from './proxy-response.js';
import { formatAnthropicModelEntry } from './server/models.js';


export type ProxyRequestContext={
  proxyToken: string;
  byAlias: Map<string, ProxyRoute>;
  defaultRoute: ProxyRoute;
  managedPools: Set<string>;
  providerRuntimeCache: ProviderRuntimeCache<LanguageModel>;
  plog: ReturnType<typeof makeProxyLog>;
  modelsPayload: () => string;
  inferenceLogPath?: string;
  webSocketDiagnosticsLogPath?: string;
};

export async function handleProxyRequest(req: IncomingMessage, res: ServerResponse, context: ProxyRequestContext): Promise<void> {
  const { proxyToken, byAlias, modelsPayload }=context;
  if(req.method==='HEAD') {
    res.writeHead(200);
    res.end();
    return;
  }

  if(await handleContextSelectionRequest(req, res, { proxyToken, byAlias })) return;

  if(req.method==='GET'&&req.url?.startsWith('/v1/models')) {
    const modelPathMatch=req.url.match(/^\/v1\/models\/([^?]+)/);
    if(modelPathMatch) {
      const id=decodeURIComponent(modelPathMatch[1]);
      const route=lookupRoute(byAlias, id);
      if(route) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(formatAnthropicModelEntry({
          id: route.aliasId,
          name: route.displayName,
          contextWindow: route.contextWindow,
          contextWindowUnconfirmed: route.contextWindowUnconfirmed,
        })));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: `Model '${id}' not found` } }));
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(modelsPayload());
    }
    return;
  }

  const messagesEndpoint=anthropicMessagesEndpoint(req.url);

  if(req.method==='POST'&&messagesEndpoint) {
    await handleProxyMessages(req, res, context, messagesEndpoint);
    return;
  }

  anthropicError(res, 404, `Unknown endpoint: ${req.method} ${req.url}`);

}
