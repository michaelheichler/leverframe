# OpenCode Zen implementation plan

Add anonymous free Zen models beside the existing OpenCode Go integration, without installing or executing OpenCode.

Reuse the HTTP adapter. Keep Zen discovery and request identity in small provider modules alongside the existing provider registry. The user requested OpenCode-compatible headers after reviewing `docs/opencode-zen-research.md`, but the hosted service may still reject them.

- Add `opencode-zen` to the provider menu, with no credential prompt and a free-only registry entry.
- Discover through `https://opencode.ai/inference/v1/models`, admitting only chat models with explicit zero prices and the expected Chat Completions endpoint.
- Send inference to `https://opencode.ai/inference/openai/v1` with the public placeholder credential and OpenCode client/session headers. Identify Leverframe in the user agent and client name.
- Preserve a Claude conversation identity across requests and keep distinct conversations separate. Use an opaque project identifier and a stable fallback session when the client supplies none.
- Keep Go credentials and request identity unchanged. Scope Zen behavior to its provider ID and official HTTPS endpoint, and prevent redirect forwarding.
- Verify discovery, registry persistence, request headers, session continuity, provider isolation, and existing provider menus with deterministic tests. Run typechecking, lint, build, package checks, and the non-live suite.

Do not change live configuration, install OpenCode, add dependencies, invoke headless Claude, rotate accounts, or retry an access denial through another identity. No commit or version bump is part of this task.
