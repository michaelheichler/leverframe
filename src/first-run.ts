

import pc from 'picocolors';
import * as p from '@clack/prompts';
import { printWelcomePanel } from './ui.js';
import { loadRegistry } from './registry/io.js';
import { isRetiredOpenAiProvider } from './registry/retired-openai.js';
import { runProvidersAdd, runProvidersAuth } from './providers-command.js';
import { OPENAI_CHATGPT_PLAN_PROVIDER_ID } from './constants.js';

export type FirstRunResult = 'continue' | 'cancel';

export async function needsFirstRunSetup(): Promise<boolean> {
  const registry = loadRegistry();
  return registry.providers.every(isRetiredOpenAiProvider);
}

export async function runFirstRunWizard(_trace = false): Promise<FirstRunResult> {
  printWelcomePanel();

  const choice = await p.select({
    message: 'How do you want to connect to OpenAI?',
    options: [
      {
        value: OPENAI_CHATGPT_PLAN_PROVIDER_ID,
        label: pc.cyan('Continue with ChatGPT'),
        hint: 'Browser sign-in for ChatGPT plan usage',
      },
      {
        value: 'apikey',
        label: pc.cyan('Use an OpenAI API key'),
        hint: 'platform.openai.com key (usage-billed)',
      },
    ],
  });
  if (p.isCancel(choice)) {
    p.cancel('Cancelled.');
    return 'cancel';
  }

  const code = choice === 'apikey' ? await runProvidersAdd() : await runProvidersAuth(choice);
  if (code !== 0) return 'cancel';

  if ((await needsFirstRunSetup())) return 'cancel';
  p.log.success('OpenAI provider ready — picking a model next.');
  return 'continue';
}
