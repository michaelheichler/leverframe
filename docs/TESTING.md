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

## Compact Stream Checks

Run `corepack pnpm exec vitest run tests/proxy.test.ts tests/live-claude-haiku.test.ts` to verify the local compact-request stream. It uses only a loopback OpenAI-compatible SSE fixture.

The Claude Code smoke test skips by default. Set `LEVERFRAME_LIVE_CLAUDE_COMPACTION_TEST=1` and set `LEVERFRAME_LIVE_CLAUDE_MODEL` to an identifier matching `^claude-haiku-[a-z0-9.-]+$` to opt in. The test rejects every other model before it invokes Claude Code and forwards that exact identifier with `--model`.

The Haiku smoke test does not validate the ChatGPT OAuth translation route. The local proxy fixture covers that translation boundary without an external provider call.

## Live provider Claude Code smoke

`tests/live-provider-claude-smoke.test.ts` sends a one-shot Claude Code prompt through `leverframe claude --proxy` for each registered provider that already has credentials. It picks the cheapest catalog model (preferred ids when present: Luna, hy3, Copilot flash, Haiku). Anthropic uses Claude Code's native model id. Other providers use `--model leverframe:<provider-id>:<model-id>`.

The command is always:

```bash
leverframe claude --proxy -- \
  --bare --tools "" \
  --print "Reply with exactly one word: OK" \
  --model <model-ref>
```

`--bare` stays even if OAuth looks broken. An OAuth failure on a `leverframe:` model is a Leverframe routing fault, not a reason to drop `--bare`.

**Skip vs pass vs fail**

- Skip the live suite when `LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE=1`.
- Skip when Claude CLI is missing, or no enabled provider has credentials (CI usually skips).
- Auto-run after a local install when Claude CLI and at least one configured provider exist.
- Force a hard fail on missing prerequisites with `LEVERFRAME_LIVE_PROVIDER_SMOKE=1`.
- Pass: the model replies `OK`, or the output is a quota/limit/429 (routing worked).
- Fail: Leverframe proxy/routing/OAuth errors, crashes, or timeouts. Failures include provider id, model id, exit code, kind, and a redacted snippet. Secrets are never written to the test file or logs.

A temp `LEVERFRAME_HOME` holds only the smoke favorites so proxy mode can route cheapest models without mutating `~/.leverframe` or deleting `smoke-*` aliases.

Wrapper: `scripts/smoke-subscription-models.sh` runs this Vitest file. The test file is the source of truth.

```bash
corepack pnpm exec vitest run tests/live-provider-claude-smoke.test.ts
```

