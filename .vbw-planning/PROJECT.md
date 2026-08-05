
Leverframe (published as `@michaelheichler/leverframe`) is a TypeScript CLI that bridges Claude Code to OpenAI-compatible model providers (OpenAI, ChatGPT/Codex OAuth, OpenCode Go, Kimi, Moonshot, z.ai, and custom OpenAI-compatible endpoints) while preserving Claude Code's tools, skills, agents, prompt caching, model switching, and auto-compaction. It runs locally as a translation proxy or gateway between the Anthropic Messages API and OpenAI-compatible backends, manages provider credentials and OAuth tokens in a local encrypted registry, and can patch the installed Claude Code binary so alternate models register as first-class, validated choices.

**Core value:** Leverframe (published as `@michaelheichler/leverframe`) is a TypeScript CLI that bridges Claude Code to OpenAI-compatible model providers (OpenAI, ChatGPT/Codex OAuth, OpenCode Go, Kimi, Moonshot, z.ai, and custom OpenAI-compatible endpoints) while preserving Claude Code's tools, skills, agents, prompt caching, model switching, and auto-compaction. It runs locally as a translation proxy or gateway between the Anthropic Messages API and OpenAI-compatible backends, manages provider credentials and OAuth tokens in a local encrypted registry, and can patch the installed Claude Code binary so alternate models register as first-class, validated choices.





- **Zero dependencies**: No package.json, npm, or build step
- **Bash + Markdown only**: All logic in shell scripts and markdown commands


| Decision | Rationale | Outcome |
|----------|-----------|---------|
