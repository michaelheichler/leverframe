import { describe, expect, it } from 'vitest';
import { createCopilotFetch, fetchCopilotModels } from '../src/copilot/backend.js';

describe('Copilot CLI integration routing', () => {
  it('requests the catalog that supplies modern model endpoint metadata', async () => {
    const modern = { id: 'gpt-6.1-sol', supported_endpoints: ['/responses'] };
    const legacy = { id: 'gpt-4o' };
    const network: typeof fetch = async input => {
      const request = input as Request;
      const models = request.headers.get('copilot-integration-id') === 'copilot-developer-cli' ? [modern] : [legacy];
      return Response.json({ data: models });
    };
    expect(await fetchCopilotModels('fixture-token', { fetchImpl: network })).toEqual([modern]);
  });

  it('uses the same integration for inference and replaces a caller header', async () => {
    let integration: string | null = null;
    const network: typeof fetch = async input => {
      integration = (input as Request).headers.get('copilot-integration-id');
      return Response.json({});
    };
    await createCopilotFetch('fixture-token', network)('https://api.githubcopilot.com/responses', {
      method: 'POST', headers: { 'copilot-integration-id': 'untrusted-caller' }, body: '{}',
    });
    expect(integration).toBe('copilot-developer-cli');
  });
});
