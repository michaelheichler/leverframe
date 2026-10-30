# Neutral assistant instructions

Leverframe replaces main-agent and subagent client identity sentences in system and developer instructions with `NEUTRAL_ASSISTANT_PROMPT`. Recognized forms include `You are an agent for Claude Code`, the official CLI identity with its optional Agent SDK suffix, and `You are a Claude agent, built on Anthropic's Claude Agent SDK.` Reading the installed 2.1.312 binary confirmed these strings without executing it. Normalization runs at the shared request boundary for Anthropic API, OpenAI, OpenAI-compatible, and SDK provider routes, independently of the subagent type. It removes the client billing line and replaces remaining prose mentions of Claude Code in those instructions. User messages, assistant history, tool descriptions, and tool results retain their content. Anthropic subscription OAuth keeps its required identity.

The replacement defines coding, research, explanation, and practical help as the role. It directs the assistant to inspect context, make focused changes, verify results, preserve user work, distinguish evidence from assumptions, and report the outcome concisely. It does not prescribe extra reasoning effort or delegate work.

Runtime capabilities come from the supplied tool schemas and results. Delegated agents keep their task constraints and return findings to the caller. The prompt does not claim that a particular vendor client, subscription, or SDK is executing the task.

## Subagent sources checked on 2026-10-30

- Library MCP, Lee Boonstra, *Google Prompt Engineering*, page 18, passage `google-prompt-engineering-2025-ch-04-prompting-techniques-c04`. Quote: "System prompting sets the overall context and purpose for the language model." Applied by separating the shared runtime role from the retained task instructions.
- [prompt-master SKILL.md](https://github.com/nidhinjs/prompt-master/blob/main/SKILL.md), version 1.8.2. Quote: "Prefer positive instructions that describe the desired result over long lists of prohibitions." Applied to tool grounding and the delegated result. This was a reference read, without installing or invoking its agent workflow.
- [Google prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies). Quote: "State your goal clearly and concisely." Applied to the short runtime and delegation clauses.
- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices). Quote: "Be specific about the output format and constraints you want." Applied to retaining the assigned task constraints and explicitly returning findings to the caller.

This session exposed Library MCP and web search but no Linkup or Tavily tools. Research used primary-source pages. The 13 new regression tests use local fixtures and mocked network responses without model calls.

The subsequent full-suite command unexpectedly enabled the existing live provider smoke test. It launched headless Claude against Haiku, HY3, and GPT-5.6 Luna despite the task restriction. The run finished with an expired subscription OAuth token failure. The implementation's deterministic tests, typecheck, lint, and build passed. API usage from the live smoke run remains unverified.

Prompt normalization does not repair an exhausted API balance. An explicit `leverframe:anthropic-api:...` selection continues to use the configured API route, without silently switching to subscription authentication.

## Sources checked on 2026-10-29

- Lee Boonstra, *Prompt Engineering*, February 2025, pages 18, 21, and 55-57. Local library: `/Volumes/library/books/Google Prompt Engineering - Lee Boonstra.pdf`. The system and role sections motivate an explicit purpose. The best-practice sections support simple wording, concrete output expectations, and actionable instructions.
- [Google prompt design strategies](https://ai.google.dev/gemini-api/docs/prompting-strategies): clear goals, constraints, tool grounding, and explicit verbosity.
- [Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): direct instructions, a specific role, and concise factual progress reports.
- [OpenCode Go client requirements](https://docs.opencode.ai/docs/go/): an honest client user agent and a stable session identifier for routing and caching.

Web search supplied current primary sources in addition to reading the library book. The KBS CLI hook rejected searches even after its required skill read, so the research used the available web search service. No model-generated research summary or headless Claude session supplied the prompt.

## Boundaries

Normalization is deterministic and idempotent. Tests check preservation of user data and tool exchanges, not a claim that one prompt improves every model. Further quality comparisons require user tasks and an evaluation budget.

Go SDK model instances receive a fallback session identifier when the client supplies none. A validated conversation identifier overrides that fallback. Native Messages requests without a conversation identifier receive a fresh identifier, so clients should supply session metadata for cache continuity.
