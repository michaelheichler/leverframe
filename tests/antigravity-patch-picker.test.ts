import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDesiredPatchConfig } from '../src/patcher.js';
import type { LocalProvider } from '../src/types.js';

const modelId = 'gemini-3.1-pro-high';
const previousHome = process.env['LEVERFRAME_HOME'];
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'antigravity-patch-picker-'));
  process.env['LEVERFRAME_HOME'] = home;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ favoriteModels: [] }));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env['LEVERFRAME_HOME'];
  else process.env['LEVERFRAME_HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Antigravity model picker integration', () => {
  it('shows the selected account model without claiming an unknown context limit', () => {
    const providers: LocalProvider[] = [{
      id: 'antigravity', name: 'Google Antigravity', apiKey: '', authType: 'oauth',
      oauthAccountId: 'account-a', providerData: { projectId: 'project-a' },
      models: [{
        id: modelId, upstreamModelId: modelId, name: 'Gemini 3.1 Pro High', family: 'gemini', brand: 'Google',
        modelFormat: 'openai', npm: '@ai-sdk/google', contextWindowUnconfirmed: true,
      }],
    }];

    const desired = buildDesiredPatchConfig(providers, { providerId: 'antigravity', modelId });

    expect(desired.config[`leverframe:antigravity:${modelId}`]).toMatchObject({
      display: 'Gemini 3.1 Pro High (Google Antigravity)', contextSelection: true,
    });
    expect(desired.config[`leverframe:antigravity:${modelId}`]).not.toHaveProperty('context');
    expect(desired.provenance[`leverframe:antigravity:${modelId}`]).toBe('unconfirmed');
  });
});
