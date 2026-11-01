# Context and Anthropic API Optimization Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Reduce eligible context safely, enable bounded opt-in summaries, and measure Anthropic requests.

**Architecture:** Apply a shared policy before passthrough or translation and retain the original request on an unsafe condition. Run deterministic reduction before optional model summaries. Encrypt and bound retained source evidence, and make it retrievable through Leverframe. Direct HTTP passthrough needs a separate entry point because it bypasses both translation callers. Account selection belongs to the account-pool work.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, AI SDK and GitNexus.

**Spec:** `docs/superpowers/specs/2026-11-01-account-pools-compaction-local-design.md`

## Global Constraints

- Default checks make no provider or model API calls. Never run headless Claude.
- Preserve instructions, objectives, decisions, unresolved errors, tool boundaries, and original evidence references. On validation failure, forward the original request and report a content-free reason.
- Deterministic reduction comes first. Model summaries require opt-in, and paid summaries require a user-set spending limit.
- Distinguish source content from instructions. Preserve recent work and unresolved exchanges. Reuse summaries only for matching identity and coverage.
- Bound summary input, output, time, and spend. Reserve an estimated maximum and charge actual usage. Fail closed on missing pricing or usage.

## Request and delivery constraints

- Preserve provider, model, billing type, streaming behavior, user cache directives, and request identity. Do not compact token-count requests.
- Support changes to Anthropic caching, counting, headers, or retries with current official evidence. Never invent a quota, price, cache hit, or token count.
- Run GitNexus upstream impact before each symbol edit and report callers, processes, and risk. Confirm UNKNOWN with source search and warn on HIGH or CRITICAL. Before every commit run `node .gitnexus/run.cjs detect-changes --scope all --repo <indexed-repo>` and resolve partial or truncated output.
- Exclude generated `dist/` files and unrelated changes from commits.

## Review Focus

- Missing session identity, unknown context window, non-JSON content, and incomplete tool calls forward the original. Task 1 covers each.
- Changed source bytes, wrong session, expired evidence, and forged references cannot resolve another session's evidence. Task 2 covers each.
- Concurrent paid summaries, crashes, missing prices, and missing actual usage cannot bypass the budget. Task 3 covers each.
- A short but incomplete or injection-bearing summary fails acceptance fixtures or remains data. Task 3 covers both.
- Cache directives, streaming usage, and direct HTTP passthrough survive policy and measurement. Task 4 covers each.

## File Structure

- `src/context/request-policy.ts` owns shared orchestration and fallback.
- `src/context/deterministic-reduction.ts` owns duplicate evidence selection and references.
- `src/context/evidence-store.ts` owns encrypted session-scoped evidence and retention.
- `src/context/summary-engine.ts` and `src/context/summary-spend.ts` define the provider-neutral engine and spending reservation.
- Existing context grouping, budget, planning, compaction validation, encryption, and retention modules supply the safety primitives.
- `src/proxy.ts`, `src/server/anthropic-inference-route.ts`, and `src/http-proxy/server.ts` wire request entry points.
- `src/config.ts`, `src/types.ts`, and terminal settings own opt-in and the paid limit.
- Existing cache, usage, and lifecycle modules preserve request semantics and measure usage.

### Task 1. Shared runtime policy and baseline

**Files:** Create `src/context/request-policy.ts` and `tests/context-policy-runtime.test.ts`. Modify `src/proxy.ts`, `src/server/anthropic-inference-route.ts`, `src/http-proxy/server.ts`, and their route tests.

**Interfaces:** The policy accepts an Anthropic-shaped request, session ID, route identity, confirmed context window, and abort signal. It returns the original or reduced request, outcome, and optional content-free reason. Each path invokes it once after routing and session identification. Direct HTTP `passthrough-messages` invokes it, while the adapter handles translated HTTP requests. Leave `count_tokens` and raw routes unchanged.

- [ ] Add fake-upstream tests for all three entry paths. Assert default requests preserve system, messages, tools, cache controls, headers, and streaming. Assert the adapter invokes the policy once. Cover absent session, unconfirmed window, malformed blocks, and unresolved tool calls.
- [ ] Run `corepack pnpm exec vitest run tests/context-policy-runtime.test.ts tests/proxy.test.ts tests/server-router-anthropic.test.ts` and verify the missing integration causes the new tests to fail.
- [ ] Implement the policy seam, abort propagation, fallback, and outcome logging. Keep execution tracking based on the original. Use grouping and budget functions only when their preconditions hold, and label estimates separately from actual tokens.
- [ ] Run the focused tests and `corepack pnpm typecheck`. Record baseline input, output, cache read/write, latency, and policy overhead on representative fake coding sessions before choosing a reduction target. Commit the reviewed task.

### Task 2. Deterministic reduction and retrievable evidence

**Files:** Create `src/context/deterministic-reduction.ts`, `src/context/evidence-store.ts`, `tests/context-evidence.test.ts`, and `tests/deterministic-reduction.test.ts`. Modify the shared policy and relevant proxy route files and tests.

**Interfaces:** The reducer returns a validated request or the original. The evidence store puts content under an opaque session-scoped reference, checks session and digest on retrieval, and rejects expired records. Expose retrieval through an authenticated local endpoint and a terminal command. Use existing encrypted-memory with workspace keys, apply retention limits, and keep storage owner-only with atomic writes. Set a 30-day maximum and a configurable storage cap.

- [ ] Add fixture tests for repeated byte-identical completed tool results with identical tool name and input. Replace only the later result body with a reference to the retained original, retaining both tool pairs and every other message byte. Assert net savings after reference overhead. Include distinct results, user instructions, unresolved tools, multimodal content, and insufficient savings, all unchanged.
- [ ] Add storage and fake-upstream tests for exact retrieval, wrong session, forged or expired reference, changed bytes, failed persistence, and oversized evidence. Failures preserve the original request. Test restart recovery and bounded cleanup.
- [ ] Run `corepack pnpm exec vitest run tests/deterministic-reduction.test.ts tests/context-evidence.test.ts tests/request-compaction.test.ts` and verify expected failures.
- [ ] Implement duplicate-only reduction, evidence storage, and retrieval for every supported route. Validate partition and tool topology with the existing validator or an equally strict lossless validator. Retain the original whenever the store cannot guarantee retrieval.
- [ ] Run the focused tests, `corepack pnpm exec vitest run tests/context-policy-runtime.test.ts tests/context-control.test.ts`, and `corepack pnpm typecheck`. Commit the reviewed task.

### Task 3. Opt-in summaries and enforced spending

**Files:** Create `src/context/summary-engine.ts`, `src/context/summary-spend.ts`, `tests/context-summary-runtime.test.ts`, and `tests/context-summary-spend.test.ts`. Modify the shared policy, `src/config.ts`, `src/types.ts`, terminal settings, and existing config tests.

**Interfaces:** The `SummaryEngine.summarize` method accepts source text, source IDs, maximum input and output tokens, and an abort signal. It returns a `StructuredSynopsis`, source IDs, and actual input tokens, output tokens, and optional cost in integer micros. Register each engine with identity and billing type. The local stage registers `ManagedLocalSummaryEngine`, which acquires an MLX runtime through `LocalModelManager`, requests a bounded summary, and reports runtime token usage through this contract. It does not use the existing single-response worker protocol. This stage includes a configured paid adapter using the existing runtime and a fake adapter for tests. Persist disabled by default, engine ID, and optional explicit lifetime limit in integer micros. Label the limit as lifetime spending in settings. Require known model prices and a positive limit for a paid engine. Atomically reserve worst-case cost under existing config locking and durable writes. Settle with actual cost. Keep crashed or expired reservations charged until reconciliation.

- [ ] Add tests for default off, opt-in persistence, absent or zero budget, unknown price, excessive estimate, insufficient balance, cancellation, and two processes competing for the last reservation. Missing or invalid actual usage consumes the reservation and blocks dispatch once the charge reaches the limit.
- [ ] Add deterministic engine fixtures for bounded input, output and deadline, source separation, exact coverage, identity-matched reuse, changed source, timeout, malformed output, tool boundary failure, and missing evidence. Use `compactAnthropicRequest` and `planRollingSummary` while preserving recent groups. Assert concrete instructions, decisions, unresolved errors, and source references. The summary remains user-level data rather than system instructions.
- [ ] Run `corepack pnpm exec vitest run tests/context-summary-runtime.test.ts tests/context-summary-spend.test.ts tests/request-compaction.test.ts` and verify expected failures.
- [ ] Implement the engine contract, configured adapter, terminal controls, spend ledger, and orchestration after deterministic reduction. Require validated summaries and measurable net savings including summary input and output. Default tests make no provider calls.
- [ ] Reject an engine result without valid actual token usage and retain the original request. Settle any paid reservation conservatively even when the summary cannot pass validation. Test local and paid engines with missing usage.
- [ ] Run the focused tests, `corepack pnpm exec vitest run tests/config.test.ts tests/context-policy-runtime.test.ts`, and `corepack pnpm typecheck`. Commit the reviewed task.

### Task 4. Anthropic request audit and acceptance

**Files:** Modify `src/anthropic-cache-control.ts`, `src/sdk-usage.ts`, `src/http-proxy/response-usage.ts`, and route code only where evidence and tests require it. Create `docs/anthropic-request-evidence.md` and `tests/anthropic-context-acceptance.test.ts`. Extend existing Anthropic cache and usage tests.

**Interfaces:** Record original and final input estimates, actual input/output and cache creation/read tokens, summary usage and cost, policy and upstream latency, provider/model, and a non-secret account affinity identifier where available. Keep missing fields unknown. Account pools own affinity and selection. Record official source URLs, retrieval date, API version, supported behavior, and unsupported assumptions before changing wire behavior.

- [ ] Add fake-upstream streaming and nonstreaming tests for ordered system, tools, cache directives, headers, payloads, and usage. Verify both native paths and the translated route, cache read/write split, omitted usage, compaction failure, and stable prefixes for unchanged source and policy identity. Never retry a streamed or ambiguous request automatically.
- [ ] Build coding-session fixtures with expected instructions, objectives, decisions, unresolved errors, source lookups, and tool topology. Compare task outcomes and net token usage, including summary input and output, against the Task 1 baseline. Do not claim a numeric target without baseline evidence. Verify deterministic and summary-disabled defaults separately.
- [ ] Run `corepack pnpm exec vitest run tests/anthropic-context-acceptance.test.ts tests/anthropic-cache-control.test.ts tests/http-proxy-response-usage.test.ts tests/http-proxy-response-usage-validation.test.ts tests/sdk-adapter.test.ts tests/proxy.test.ts tests/server-router-anthropic.test.ts` and verify missing audit behavior fails before implementation.
- [ ] Apply evidence-backed wire optimizations and preserve client caching policy and headers. Record measurements without request content or credentials. Consult Anthropic [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), and [rate limits](https://platform.claude.com/docs/en/api/rate-limits), verified 2026-11-01. Automatic top-level cache control is the documented starting point where supported, and explicit breakpoints offer finer control. Do not override client policy or pad prompts to meet minima. Preserve stable prefixes and workspace isolation. The default TTL is five minutes and one-hour writes cost more. Total input usage equals input plus cache-read plus cache-creation tokens. Track separate TTL creation where available.
- [ ] Run the focused tests, all context tests, `corepack pnpm typecheck`, `corepack pnpm lint`, and `git diff --check`. Complete GitNexus change analysis, obtain independent QA, and commit the reviewed task. The user runs any interactive Claude Code check.
