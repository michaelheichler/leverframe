/** Because Copilot protocols must not inherit Codex rules. */
import { expect, it } from 'vitest';
import { isOpenAiOAuth, isSdkMigratedNpm } from '../src/provider-factory.js';

it('uses an HTTP adapter for Copilot Anthropic-format models', () => {
  expect(isSdkMigratedNpm('@ai-sdk/anthropic', 'github-copilot')).toBe(true);
});

it.each(['anthropic', 'claude-code', 'opencode-go', undefined])('preserves native Anthropic routing for %s', providerId => {
  expect(isSdkMigratedNpm('@ai-sdk/anthropic', providerId)).toBe(false);
});

it('does not accept a missing protocol for Copilot', () => {
  expect(isSdkMigratedNpm(undefined, 'github-copilot')).toBe(false);
});

it('does not apply Codex subscription behavior to Copilot Responses', () => {
  expect(isOpenAiOAuth('@ai-sdk/openai', 'oauth', 'github-copilot')).toBe(false);
});

it.each(['openai', 'openai-oauth', undefined])('preserves OpenAI OAuth behavior for %s', providerId => {
  expect(isOpenAiOAuth('@ai-sdk/openai', 'oauth', providerId)).toBe(true);
});

it.each(['api', 'none', undefined])('does not treat %s authentication as OpenAI OAuth', authType => {
  expect(isOpenAiOAuth('@ai-sdk/openai', authType, 'openai')).toBe(false);
});
