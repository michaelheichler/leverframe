# Changelog

<!-- markdownlint-configure-file {"MD024": {"siblings_only": true}} -->

All notable changes to Leverframe are recorded here.

## [0.3.9] - 2026-08-16

### Fixed

- Model aliases are canonicalized to lowercase at the config boundary, matching the lowercase identities emitted by the Claude Code patch and restoring short-alias routing for Kimi, GitHub Copilot, OpenCode Go, and other non-OpenAI providers.
- Existing mixed-case aliases work immediately on read and are durably migrated on the next preference write without changing provider or upstream model identifiers.
- `models --alias` and `models --unalias` use the same canonical alias identity.

### Safety

- Aliases that collide after lowercase normalization fail with both conflicting targets instead of silently selecting a route.
- Malformed external alias entries fail with an actionable configuration error, while unknown model ids continue to fail closed to Anthropic passthrough.

## [0.3.8] - 2026-08-14

### Added

- Live Claude Code provider smoke test (`tests/live-provider-claude-smoke.test.ts`) that routes each configured provider through `leverframe claude --proxy` with `--bare --tools ""`. Quota and rate-limit responses count as pass.
- Copilot message tests for latest-turn-only image attachment on stateful sessions.
- Credential durability test for self-healing a stale active journal when the published credential is missing.

### Changed

- Provider credential loading during catalog startup is sequential instead of parallel, reducing Linux D-Bus keyring timeouts when many providers are registered.
- Copilot stateful sessions attach images from the latest user turn only, not the full conversation history.
- Build copies `keyring-child.mjs` with Node `copyFileSync` instead of `cp` for cross-platform compatibility.

### Fixed

- `--bare` Claude Code proxy runs authenticate correctly (Anthropic origin pinning, placeholder key handling, passthrough OAuth on macOS via `security` CLI).
- Anthropic usage-limit responses map to client-facing 400 instead of 503 where appropriate.
- V2 patch false positive when smoke tests use a temporary `LEVERFRAME_HOME`.
- Keyring journal self-heals when the active descriptor is stale. Clears orphaned retired chunks, verifies journal removal, and drops only retired chunk material when the published slot is empty.
- Credential reads auto-repair transient keyring integrity errors before falling back or failing. Staged fallback still wins over a readable but older keyring value.
- After a successful auto-repair that leaves the leverframe slot empty, legacy `clodex`/`relay-ai` secrets are not revived. Post-repair re-read failures still allow legacy migration.
- Copilot rejects remote non-image file parts in serialized history (requires `image/*` media type).
- CI secret scan allowlists the documented HTTP proxy placeholder key. Provenance test timeout adjusted for Ubuntu CI.

## Unreleased

### Added

- Claude Code Agent launches now show a colored routing confirmation with the resolved model and effective reasoning level. The notice is rendered through Claude Code's notification UI and is not written to process output.
- Context infrastructure for budgeting, compaction planning, summaries, trusted metadata, encrypted memory, local inference profiling, retention, vector memory, and worker supervision.
- Read-only patch diagnostics with installation identity, version support, manifest, drift, transaction, lock, and legacy recovery details.
- Quality, testing, and technical-debt documents for the context and compaction work.

### Changed

- The binary patch transform version is now 4, with Claude Code 2.1.226 Agent-launch compatibility coverage and machine-readable output protection for the routing notice. Existing patched installations are treated as stale and re-patched on next launch.
- Claude Code binary patching now requires version 2.1.223 or newer. Older installations receive an upgrade instruction while proxy mode remains available.
- ChatGPT/Codex OAuth context windows now use positive finite provider metadata. Missing or invalid values remain unconfirmed.
- Context budgeting uses named token costs instead of positional array indexes.

### Fixed

- Claude Code 2.1.226 Agent model validation now supports the current function-style schema while retaining the legacy enum schema.
- Patch publication records the staged binary identity before the atomic rename, closing a crash-recovery gap.
- Model alias and context lookup tables use null-prototype objects to prevent prototype-key collisions.
- Repeated patching recognizes complete injected sites even when post-publication signing changes the exact binary hash.

### Safety

- Unsupported versions are rejected before binary inspection or patch-state mutation. Restore remains available for valid existing state.
- Patch transforms remain fail-closed when a required anchor is missing or ambiguous.
- The new compaction infrastructure remains outside the production request path until its integration evidence is complete.
