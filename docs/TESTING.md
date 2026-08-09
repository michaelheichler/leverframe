# Testing

## Test Strategy

Compaction changes require focused Vitest coverage before production edits. Use pure request and metadata seams first. Add a captured Claude Code stream fixture before changing stream behavior.

## Safety Net Map

| Module | Pinned behaviors | Test files | Gaps |
|---|---|---|---|
| `src/sdk-adapter.ts` | Only the exact Claude Code compaction request disables tools. Ordinary structured output keeps its tool choice. | `tests/sdk-adapter.test.ts` | No captured failing API stream. |
| `src/sdk-adapter.ts` | A text response ends with valid Anthropic SSE terminal events. | `tests/sdk-adapter.test.ts` | No end-to-end compact-request stream fixture. |
| `src/data/openai-oauth-models.ts` | GPT-5.6 Sol uses the static `272000` seed when live metadata is absent. | `tests/openai-oauth-models.test.ts` | The fallback is not provider truth. |
| `src/context/` | Tool groups, budgets, watcher state, and request rewrite preserve their current contracts. | `tests/context-control.test.ts`, `tests/request-compaction.test.ts` | No production caller connects the modules. |

## Characterization Backlog

- [ ] Capture and replay the Claude Code request and SSE response from a pre-compaction stream break. (Codex, P0)
- [ ] Add an adapter-level compact-request stream fixture that asserts terminal SSE events. (Codex, P0)
- [ ] Add a live-model metadata fixture that proves `context_window` provenance from the ChatGPT OAuth endpoint. (Codex, P0)

## CI Gates

Run `corepack pnpm exec vitest run tests/context-control.test.ts tests/request-compaction.test.ts tests/openai-oauth-models.test.ts tests/sdk-adapter.test.ts` before a Compaction change.
