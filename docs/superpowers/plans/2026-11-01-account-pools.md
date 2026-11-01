# Account Pools Implementation Plan

Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement each task. Checkboxes track progress.

**Goal**

Manage multiple Anthropic API and ChatGPT OAuth accounts and safely route requests across each eligible pool.

**Architecture**

Select an account before credential binding. A locked, secret-free shared state coordinates scoped capacity, reservations and session affinity. Native Anthropic and translated ChatGPT requests use the same safe failover and exhaustion contract.

**Tech Stack**

TypeScript, Node 22+, Vitest, existing registry locks and atomic file utilities.

**Spec**

`docs/superpowers/specs/2026-11-01-account-pools-compaction-local-design.md`, account stage only.

## Global Constraints

- Both balancing and quota failover default on, with separate terminal switches. Accounts must match provider, model and billing type. Exclude Claude Code subscription credentials.
- Keep healthy session affinity. Unknown capacity stays unknown and rotates equally. Record observation source, time, scope and confirmed reset or retry time.
- Retry only confirmed quota rejection before response output, at most once per eligible account. Ambiguous failures and output already emitted never replay.
- Pool exhaustion reaches every affected agent on its next request through JSON or SSE, with attempts and confirmed reset when known. Healthy streams and pools continue.
- Use local fixtures and fake upstreams only. Never run headless Claude or call provider or model APIs in default checks.
- Run GitNexus upstream impact before each symbol edit, report callers, processes and risk, warn on HIGH or CRITICAL, and source-check UNKNOWN. Run complete detect-changes before each commit.
- Preserve unrelated changes. Coding workers use Terra High and independent QA uses Luna Max.

## Review Focus

- Removed accounts and active reservations must not restore accounts or expose secrets. Tasks 2 and 3 test this.
- Shared quota buckets must suppress linked accounts only when evidence supports the association. Task 3 tests this.
- Dead process reservations must expire. Task 3 tests this.
- Partial stream output must prevent replay. Task 4 tests both paths.
- Legacy OAuth account metadata must survive migration and refresh. Tasks 1 and 4 test this.

## File Map

- Registry identity and credential lifecycle use `src/registry/types.ts`, `io.ts`, `migrate.ts`, `validate.ts`, `load.ts`, `credential-lifecycle.ts`, `provider-auth.ts` and `src/env.ts`.
- Management and controls use `src/providers-command-crud.ts`, `providers-command-auth.ts`, `src/config.ts`, `src/types.ts` and the terminal prompt entry.
- Selection and cross-process state use new files `src/account-pool.ts` and `src/account-pool-state.ts`.
- Binding, failover and errors use `src/proxy-request.ts`, `src/proxy.ts`, `src/upstream-forward.ts`, `src/provider-runtime-cache.ts`, `src/proxy-response.ts` and `src/upstream-error.ts`.

### Task 1. Stable accounts and credential migration

Modify registry files and `src/env.ts` above. Test with `tests/account-registry.test.ts`, `tests/credential-lifecycle.test.ts` and `tests/credential-durability.test.ts`.

Add `RegistryAccount` with `id`, `authRef` and `enabled` fields and optional `RegistryProvider.accounts`. Add `migrateProviderAccounts(registry)` which preserves the original `authRef` on a deterministic first account. Account-scoped credential resolution accepts provider ID and account and returns the existing auth shape, including OAuth account ID and provider data.

- [ ] Test legacy API and OAuth migration, duplicate account IDs or references, idempotence, failed publication and OAuth refresh preserving metadata. Assert registry JSON contains no secret.
- [ ] Run `pnpm exec vitest run tests/account-registry.test.ts` and confirm the new behavior fails.
- [ ] Implement compatible parsing, validation, migration and account-scoped credential storage. Preserve provider IDs and legacy references. Delete an unshared secret only after durable account removal.
- [ ] Run `pnpm exec vitest run tests/account-registry.test.ts tests/credential-lifecycle.test.ts tests/credential-durability.test.ts` and confirm all pass.
- [ ] Run complete graph change analysis, review affected flows and commit the task.

### Task 2. Account management and controls

Modify `src/providers-command-crud.ts`, `src/providers-command-auth.ts`, `src/config.ts`, `src/types.ts` and the terminal settings prompt. Test with `tests/account-management.test.ts` and existing provider command tests.

Store optional boolean preferences `accountPoolBalancing` and `accountPoolFailover`, treating absence as true. Expose add, explicit import, remove and pin operations using provider and account IDs. Display active account and latest switch reason without secrets.

- [ ] Test both defaults, independent persistence, pinned selection with balancing off, explicit import, removal preserving other accounts and shared credentials, and display without secrets.
- [ ] Run `pnpm exec vitest run tests/account-management.test.ts` and confirm failure.
- [ ] Extend provider detail and settings flows. Offer discovery only from documented credential locations, show the source and require explicit import. Route OAuth login and API key entry to distinct account references.
- [ ] Run the focused test and existing provider command and configuration tests identified by `rg --files tests | rg 'provider|config|prompt'`. Confirm all pass.
- [ ] Run complete graph change analysis, review affected flows and commit the task.

### Task 3. Shared capacity scheduler

Create `src/account-pool.ts`, `src/account-pool-state.ts`, `tests/account-pool.test.ts` and `tests/account-pool-process.test.ts`. Reuse `src/registry/lock.ts`, `src/atomic-file.ts` and `src/paths.ts`.

Define `PoolKey` with provider ID, model ID and API or OAuth billing type. Define `CapacityObservation` with account ID, scope, source, observation time, status, optional reset time and optional remaining capacity. Status distinguishes healthy, rate limited, exhausted, authentication failure and unknown. `reserveAccount` accepts pool, optional session ID, accounts, balancing setting, optional pinned account and current time, and returns a reservation or pool exhaustion. `recordObservation` and `releaseReservation` update shared state. Reservations contain opaque ID, account ID and expiry, never credentials.

- [ ] Test equal rotation for unknown capacity, healthy affinity, comparable observed capacity, pinned mode, distinct failure states, evidence-backed shared buckets, reset recovery, removal, expiry and secret-free state. Spawn two fixture processes against one temporary home and assert atomic selection and no lost updates.
- [ ] Test that stale observations cannot overwrite newer state. When exhaustion has no confirmed reset, allow a bounded recovery attempt on a later incoming request after a local cooldown. Keep that local probe time separate from provider reset information. Do not send standalone prompts to probe quota.
- [ ] Run `pnpm exec vitest run tests/account-pool.test.ts tests/account-pool-process.test.ts` and confirm failure.
- [ ] Implement locked read, modify and atomic write with bounded expiring reservations. Associate shared scopes only on verified evidence and never infer balance from token usage. Preserve healthy affinity and reconcile the current registry at selection.
- [ ] Run the focused tests and confirm all pass, including the multi-process fixture.
- [ ] Run complete graph change analysis, review affected flows and commit the task.

### Task 4. Native and translated request failover

Modify `src/proxy.ts`, `src/proxy-request.ts`, `src/upstream-forward.ts`, `src/upstream-error.ts`, `src/proxy-response.ts`, `src/provider-runtime-cache.ts` and OAuth adapter seams. Test with `tests/account-pool-proxy.test.ts` and existing proxy, relay and OAuth tests.

Add `classifyPoolFailure` returning a capacity observation only for structured, verified evidence. Add `dispatchWithPool` to reserve, resolve and dispatch, then record and release in `finally`. Limit attempts to each eligible account once and preserve the original pool key.

[Anthropic rate limits](https://platform.claude.com/docs/en/api/rate-limits), read 2026-11-01, describes organization and configurable workspace limits, per-model-class request and token buckets, remaining and reset headers, and retry-after on most 429 responses. Spend cap 429 responses may omit retry-after. Do not assume keys have independent capacity or conflate spend and rate limits. Treat unsupported ChatGPT telemetry as unknown.

The official [Codex rate-limit parser](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs), read 2026-11-01, provides evidence for primary and secondary usage windows from response headers and structured rate-limit events. Preserve server-provided limit identifiers and durations rather than assuming fixed model names or five-hour and weekly windows. Parse only validated numeric usage and confirmed reset timestamps, and keep missing telemetry unknown.

- [ ] Test both paths with confirmed quota rejection then alternate success, exhaustion with and without confirmed reset, unrelated healthy pool, separate main and subagent next requests, and reset recovery. Assert provider, model and billing type stay fixed.
- [ ] Test failover off with two eligible accounts and a confirmed quota rejection. Assert exactly one upstream dispatch and the original failure reaches the caller. Test balancing off independently with the pinned account.
- [ ] Test successful Anthropic remaining/reset headers and Codex usage-window headers or events updating comparable pool capacity. Cover malformed values, dynamic limit IDs, stale observations, and absent telemetry without inferred balances.
- [ ] Test 401, ambiguous 429, timeout, disconnect, partial SSE output followed by error, and a healthy in-flight stream while the pool exhausts. Assert one dispatch for ambiguous or post-output failure and preserve safe upstream detail in JSON or SSE.
- [ ] Run `pnpm exec vitest run tests/account-pool-proxy.test.ts` and confirm failure.
- [ ] Select before credential snapshot and runtime creation. Include account identity and credential generation in cache keys and evict stale bindings. Refactor native relay to return structured pre-response rejection before writing headers, and route SDK failures through the same boundary. Coordinate existing lifecycle and OAuth retries to prevent extra replay. Interpret only verified telemetry.
- [ ] Run the focused test and existing proxy, relay and OAuth tests identified by `rg --files tests | rg 'proxy|upstream|oauth'`. Confirm all pass.
- [ ] Run complete graph change analysis, review affected flows and commit the task.

### Task 5. Integrated verification and independent QA

Exercise the preceding tasks together and make only narrow corrections found in review.

- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run --exclude 'tests/live-*.test.ts'` and `pnpm build`. Record results, fix failures in scope and rerun relevant checks. Keep the known baseline installed-binary patch failure separate from account-pool regressions.
- [ ] Run the fake-upstream suite with two processes, each toggle separately disabled, account removal during an active request and both providers. Verify tests do not contact external services.
- [ ] Have independent Luna Max QA review migration, locking, safe replay and JSON/SSE delivery against this plan and the spec. Record each finding with file, line, rule and action, fix it and rerun its check.
- [ ] Run complete GitNexus detect-changes for all work and review affected flows. Commit corrections and identify interactive Claude Code verification as user-run only.
