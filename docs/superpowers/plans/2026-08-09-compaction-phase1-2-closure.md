# Compaction Phase 1 and 2 Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatGPT OAuth context windows provider-authoritative, preserve the Claude compaction stream contract, and keep live Claude Code testing opt-in and Haiku-only.

**Architecture:** ChatGPT OAuth seeds identify models and capabilities, but never assert a context limit. A positive finite `context_window` returned by the authenticated ChatGPT backend is retained. Missing or malformed metadata is represented as `contextWindowUnconfirmed`, which prevents launch code from adding a max-context override or `[1m]` suffix. Stream safety remains at the existing adapter seam, with an end-to-end deterministic test that covers request translation and terminal Anthropic SSE events.

**Tech Stack:** TypeScript, Node.js 22+, Vitest 2, AI SDK 7, GitNexus.

## Global Constraints

- Default tests must not call Claude Code, OpenAI, ChatGPT OAuth, or another external provider.
- An opt-in live test must refuse every model identifier except `claude-haiku-*`.
- Provider `context_window` is authoritative only when it is a positive finite number.
- Missing or invalid ChatGPT OAuth context metadata must stay unconfirmed. It must not use a seed, cache, heuristic, default, max-context environment override, or `[1m]` suffix.
- Do not wire `src/context/request-compaction.ts` into production during this plan.
- Keep the existing behavior for a positive explicit context window.
- Do not modify, stage, or commit generated `dist/` files in this plan.
- Run GitNexus impact analysis before every source-function edit and run `gitnexus detect_changes --repo leverframe --scope all` before committing.

---

### Task 1: Preserve context-window provenance through refresh and launch

**Files:**
- Modify: `src/data/openai-oauth-models.ts:20-82`
- Modify: `src/registry/refresh-models.ts:60-217`
- Modify: `src/env.ts:40-69`
- Modify: `src/context-model-id.ts:14-23`
- Modify: `tests/openai-oauth-models.test.ts:1-11`
- Create: `tests/openai-oauth-refresh.test.ts`
- Create: `tests/context-model-id.test.ts`
- Create: `tests/env.test.ts`

**Interfaces:**
- Consumes: `CachedModel.contextWindow?: number`, `CachedModel.contextWindowUnconfirmed?: boolean`, and ChatGPT backend entries with `context_window?: unknown`.
- Produces: provider windows only when the backend reports a positive finite number. All seed and unknown windows use `contextWindowUnconfirmed: true`. `buildChildEnv` and `claudeCodeClientModelId` preserve an explicit window and avoid inference when it is undefined.

- [ ] **Step 1: Write failing seed, refresh, environment, and model-id tests**

Use literal provider responses and model identifiers. Cover these observable outcomes:

```ts
expect(buildOpenAiOAuthModels().find(model => model.id === 'gpt-5.6-sol')).toMatchObject({
  contextWindow: undefined,
  contextWindowUnconfirmed: true,
});

expect(refreshedModel).toMatchObject({
  id: 'gpt-5.6-sol',
  contextWindow: 272_000,
  contextWindowUnconfirmed: undefined,
});

expect(unconfirmedModel).toMatchObject({
  contextWindow: undefined,
  contextWindowUnconfirmed: true,
});

expect(claudeCodeClientModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
expect(buildChildEnv('http://127.0.0.1:9999', 'gpt-5.6-sol', 'token', 9999).CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
```

Mock only the network, registry I/O, pricing, credential lifecycle, and Claude-version lookup below `refreshProviderModels`. Assert the persisted model cache after a ChatGPT Codex response with a numeric `context_window`, an absent value, and an invalid value. Seed fallback must be unconfirmed.

- [ ] **Step 2: Run the new tests and verify expected failures**

Run: `corepack pnpm exec vitest run tests/openai-oauth-models.test.ts tests/openai-oauth-refresh.test.ts tests/context-model-id.test.ts tests/env.test.ts`

Expected: failures show that seeds assert `272000`, missing metadata uses inference, or launch sets an override.

- [ ] **Step 3: Implement the minimum provenance behavior**

```ts
const isPositiveFiniteContextWindow = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const contextWindow = isPositiveFiniteContextWindow(entry.context_window)
  ? entry.context_window
  : undefined;
```

Remove OAuth seed windows and mark seed records unconfirmed. Apply a positive provider window to both seeded and newly discovered OAuth records. Otherwise keep the context undefined and mark it unconfirmed. Do not call `resolveContextWindow` on this OAuth path.

In `claudeCodeClientModelId`, return the bare model id when no explicit window is supplied. In `buildChildEnv`, delete inherited `CLAUDE_CODE_MAX_CONTEXT_TOKENS` first and set it only for a positive explicit window.

- [ ] **Step 4: Run the focused tests and source checks**

Run: `corepack pnpm exec vitest run tests/openai-oauth-models.test.ts tests/openai-oauth-refresh.test.ts tests/context-model-id.test.ts tests/env.test.ts`

Run: `corepack pnpm typecheck`

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the reviewed task**

Stage only the Task 1 source and test files after task review. Commit message: `fix: preserve OAuth context-window provenance`.

### Task 2: Pin compact request streaming and add the Haiku-only live guard

**Files:**
- Modify: `tests/proxy.test.ts:666-760`
- Create: `tests/live-claude-haiku.test.ts`
- Modify: `docs/TESTING.md:1-30`

**Interfaces:**
- Consumes: `startProxyCatalog`, the current exact Claude Code compaction instruction, and the existing real-AI-SDK OpenAI-compatible loopback stream fixture.
- Produces: a deterministic local test that proves the production proxy path disables upstream tool choice and emits a complete terminal Anthropic text stream. The opt-in smoke test accepts only a Haiku model identifier and does not run unless explicitly enabled.

- [ ] **Step 1: Write failing compact-stream and live-guard tests**

Send the exact compaction request with `StructuredOutput` through the existing local `startProxyCatalog` fixture and respond with deterministic OpenAI-compatible text SSE. Assert the captured upstream request and these literal returned event types:

```ts
expect(events.map(event => event.event)).toEqual([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
]);
expect(params.toolChoice).toBe('none');
expect(events.some(event => event.data?.delta?.stop_reason === 'tool_use')).toBe(false);
```

Create an opt-in live test that skips unless `LEVERFRAME_LIVE_CLAUDE_COMPACTION_TEST=1`. When enabled, it must throw before spawning Claude Code unless `LEVERFRAME_LIVE_CLAUDE_MODEL` matches `^claude-haiku-[a-z0-9.-]+$`. The command must pass that exact model through `--model`.

- [ ] **Step 2: Run the local compact-stream and live-guard tests**

Run: `corepack pnpm exec vitest run tests/proxy.test.ts tests/live-claude-haiku.test.ts`

Expected: the characterization test passes against the existing proxy behavior. The live test is skipped and makes no external call.

- [ ] **Step 3: Add only test seams and test policy documentation**

Reuse the existing local loopback helper in `tests/proxy.test.ts`. Do not alter `translateRequest`, `writeAnthropicStream`, `streamAnthropicResponse`, `src/proxy.ts`, or `src/server/router.ts` unless the deterministic test reveals an actual contract failure.

Document the default local test command, the opt-in flag, the exact Haiku model validation, and the fact that a Haiku smoke test does not validate the ChatGPT OAuth translation route.

- [ ] **Step 4: Run focused tests and source checks**

Run: `corepack pnpm exec vitest run tests/proxy.test.ts tests/live-claude-haiku.test.ts`

Run: `corepack pnpm lint`

Expected: focused tests pass, the live test is skipped by default, and lint reports no errors.

- [ ] **Step 5: Commit the reviewed task**

Stage only the Task 2 tests and documentation after task review. Commit message: `test: pin compact stream and Haiku live guard`.

### Task 3: Close the Phase 1 and 2 evidence gate

**Files:**
- Modify: `docs/IMPROVE-CODE-QUALITY-PLAN.md:1-70`
- Modify: `docs/TESTING.md:1-30`
- Modify: `docs/TECH-DEBT.md:1-48`

**Interfaces:**
- Consumes: passing focused tests, typecheck, lint, GitNexus impact output, and task reviews.
- Produces: accurate Phase 1 and Phase 2 statuses, a completed Safety Net Map, and remaining debt only for work not authorized in this plan.

- [ ] **Step 1: Verify the integrated local test suite**

Run: `corepack pnpm exec vitest run tests/context-control.test.ts tests/request-compaction.test.ts tests/openai-oauth-models.test.ts tests/openai-oauth-refresh.test.ts tests/context-model-id.test.ts tests/env.test.ts tests/sdk-adapter.test.ts tests/proxy.test.ts tests/live-claude-haiku.test.ts`

Expected: all local tests pass and the live test is skipped unless explicitly enabled with a Haiku identifier.

- [ ] **Step 2: Run repository checks and inspect changed execution flows**

Run: `corepack pnpm typecheck`

Run: `corepack pnpm lint`

Run: `git diff --check`

Run: `gitnexus detect_changes --repo leverframe --scope all`

Expected: source checks pass, no whitespace errors occur, and GitNexus reports only the planned context and test impact.

- [ ] **Step 3: Update quality artifacts with verified evidence**

Mark Phase 1 done only if the deterministic compact-stream and provider-metadata tests pass. Mark Phase 2 done only if the existing context-budget readability change still passes the expanded Phase 1 safety net. Keep automatic custom compaction as deferred debt, with no production integration claim.

- [ ] **Step 4: Commit the final documentation**

Stage only the approved documentation updates after task review. Commit message: `docs: close compaction quality phases`.

- [ ] **Step 5: Run the final whole-branch review and push**

Run the final task review over the branch diff. If it is clean, push `main` to `origin`. Do not include generated `dist/` files.
