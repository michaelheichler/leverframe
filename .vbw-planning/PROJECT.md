
Leverframe (published as `@michaelheichler/leverframe`) is a TypeScript CLI that bridges Claude Code to OpenAI-compatible model providers (OpenAI, ChatGPT/Codex OAuth, OpenCode Go, Kimi, Moonshot, z.ai, and custom OpenAI-compatible endpoints). It preserves Claude Code's tools, skills, agents, prompt caching, model switching, and auto-compaction. It runs locally as a translation proxy or gateway between the Anthropic Messages API and OpenAI-compatible backends. It manages provider credentials and OAuth tokens in a local encrypted registry. It can patch the installed Claude Code binary so alternate models register as first-class, validated choices.

**Core value:** Bridge Claude Code to any OpenAI-compatible model provider without giving up Claude Code's native tooling (tools, skills, agents, prompt caching, model switching, auto-compaction).

- **TypeScript CLI**: single-package repo (not a monorepo), built and run with pnpm
- **131 source files** under `src/`, 73 test files under `tests/` (vitest)
- **CI**: `.github/workflows/ci.yml`

| Decision | Rationale | Outcome |
|----------|-----------|---------|
