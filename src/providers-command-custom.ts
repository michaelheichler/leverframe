import * as p from '@clack/prompts';
import { addCustomEndpointProvider } from './registry/custom-endpoint.js';
import { validateCustomEndpointUrl } from './registry/url-security.js';
import { logConnected } from './ui.js';

async function promptCustomEndpointUrl(): Promise<{ baseUrl: string; allowInsecureLocal: boolean } | number> {
  const input = await p.password({ message: 'Base URL (for example https://api.example.com/v1):' });
  if (p.isCancel(input)) return 0;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    p.log.error('Invalid base URL. Include https:// and the full base path.');
    return 1;
  }
  if (url.username || url.password || url.search || url.hash) {
    p.log.error('Use a base URL without credentials, query parameters, or fragments. Enter the API key separately.');
    return 1;
  }
  const checked = await validateCustomEndpointUrl(input);
  if (checked.ok && checked.normalizedUrl) {
    return { baseUrl: checked.normalizedUrl, allowInsecureLocal: false };
  }
  const local = await validateCustomEndpointUrl(input, { allowInsecureLocal: true });
  if (!local.ok || !local.normalizedUrl) {
    p.log.error(local.error ?? 'Endpoint URL failed security validation.');
    return 1;
  }
  const approved = await p.confirm({
    message: 'Allow this trusted local/LAN endpoint? HTTP sends prompts and credentials without encryption.',
    initialValue: false,
  });
  if (p.isCancel(approved) || !approved) return 0;
  return { baseUrl: local.normalizedUrl, allowInsecureLocal: true };
}

export async function runCustomEndpointAddFlow(): Promise<number> {
  const displayName = await p.text({
    message: 'Provider display name:',
    validate: value => value.trim() ? undefined : 'Name cannot be empty',
  });
  if (p.isCancel(displayName)) return 0;
  const endpoint = await promptCustomEndpointUrl();
  if (typeof endpoint === 'number') return endpoint;
  const auth = await p.select({
    message: 'Endpoint authentication',
    options: [
      { value: 'api', label: 'API key (Bearer token)' },
      { value: 'none', label: 'No authentication' },
    ],
  });
  if (p.isCancel(auth)) return 0;
  let apiKey = '';
  if (auth === 'api') {
    const secret = await p.password({
      message: 'API key:',
      validate: value => value.trim() ? undefined : 'Key cannot be empty',
    });
    if (p.isCancel(secret)) return 0;
    apiKey = secret.trim();
  }
  const spinner = p.spinner();
  spinner.start('Discovering endpoint models...');
  let result;
  try {
    result = await addCustomEndpointProvider({
      displayName: displayName.trim(), ...endpoint, apiKey, kind: 'openai',
    });
  } catch {
    p.log.error('Could not add endpoint. Check endpoint availability and credential storage, then retry.');
    return 1;
  } finally {
    spinner.stop('');
  }
  if (!result.added) {
    const redact = (text: string) => apiKey ? text.split(apiKey).join('[redacted]') : text;
    p.log.error(redact(result.error ?? 'Could not add endpoint. Check the base URL, API key, and model discovery support.'));
    if (result.hint) p.log.info('Check the endpoint URL, API key, and model discovery support.');
    return 1;
  }
  logConnected(displayName.trim(), result.modelCount ?? 0);
  return 0;
}
