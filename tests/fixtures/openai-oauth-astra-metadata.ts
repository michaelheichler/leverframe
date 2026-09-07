export const OPENAI_OAUTH_ASTRA_MODEL = {
  slug: 'gpt-6-astra',
  title: 'GPT-6 Astra',
  context_window: 272_000,
  max_context_window: 872_000,
  supported_reasoning_levels: [
    { effort: 'low', description: 'Fast responses with lighter reasoning' },
    { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    { effort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
  ],
  default_reasoning_level: 'medium',
  minimal_client_version: '0.153.0',
  supports_reasoning_summaries: true,
  supports_reasoning_summary_parameter: true,
  supports_parallel_tool_calls: true,
  use_responses_lite: true,
  prefer_websockets: true,
  temperature: false,
  limit: { input: 922_000, output: 128_000 },
} as const;

export const OPENAI_OAUTH_ASTRA_FAILURE = {
  status: 400,
  body: "{\"detail\":\"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.\"}",
} as const;
