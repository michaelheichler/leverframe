import { isSdkMigratedNpm } from '../provider-factory.js';
import { revalidateEndpointUrl } from './route-helpers.js';
import { supportsDirectOpenAIChatCompletions, type ServerModelInfo } from './models.js';

export async function validateAnthropicMessagesRoute(model: ServerModelInfo): Promise<string | undefined> {
  if (model.modelFormat === 'anthropic') {
    if (!model.baseUrl) return `Model ${model.id} has no Anthropic baseUrl configured`;
    if (!/^https?:\/\//i.test(model.baseUrl)) return 'Invalid provider baseUrl: must be http:// or https://';
    const revalidation = await revalidateEndpointUrl(model.baseUrl);
    if (!revalidation.ok) {
      return `Custom endpoint URL failed security revalidation: ${revalidation.error ?? 'unspecified'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`;
    }
    return undefined;
  }

  if (model.modelFormat === 'openai') {
    if (!isSdkMigratedNpm(model.npm)) return `No SDK provider for model: ${model.id}`;
    if (model.apiBaseUrl && !/^https?:\/\//i.test(model.apiBaseUrl)) {
      return 'Invalid provider apiBaseUrl: must be http:// or https://';
    }
    if (model.apiBaseUrl) {
      const revalidation = await revalidateEndpointUrl(model.apiBaseUrl);
      if (!revalidation.ok) {
        return `Custom endpoint URL failed security revalidation: ${revalidation.error ?? 'unspecified'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`;
      }
    }
    return undefined;
  }

  return `Unsupported model format: ${model.modelFormat}`;
}

export async function validateOpenAiChatRoute(model: ServerModelInfo): Promise<string | undefined> {
  if (supportsDirectOpenAIChatCompletions(model)) {
    if (!model.completionsUrl) return `Model ${model.id} has no completionsUrl configured`;
    if (!/^https?:\/\//i.test(model.completionsUrl)) {
      return 'Invalid provider completionsUrl: must be http:// or https://';
    }
    const revalidation = await revalidateEndpointUrl(model.apiBaseUrl ?? model.completionsUrl);
    if (!revalidation.ok) {
      return `Custom endpoint URL failed security revalidation: ${revalidation.error ?? 'unspecified'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`;
    }
    return undefined;
  }

  const npm = model.npm || (model.modelFormat === 'anthropic' ? '@ai-sdk/anthropic' : undefined);
  if (!npm) return `No SDK provider for model: ${model.id}`;
  const baseURL = model.modelFormat === 'anthropic' ? model.baseUrl : model.apiBaseUrl;
  if (!baseURL) return undefined;
  if (!/^https?:\/\//i.test(baseURL)) return 'Invalid provider baseURL: must be http:// or https://';
  const revalidation = await revalidateEndpointUrl(baseURL);
  if (!revalidation.ok) {
    return `Custom endpoint URL failed security revalidation: ${revalidation.error ?? 'unspecified'}${revalidation.hint ? ` ${revalidation.hint}` : ''}`;
  }
  return undefined;
}
