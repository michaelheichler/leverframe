# Model routing implementation plan

> For agentic workers. Use `superpowers:executing-plans` for native execution or `superpowers:subagent-driven-development` if the user chooses delegated execution. Track each step with its checkbox.

## Goal

Expose one `auto` entry in Claude Code, keep the cheap front router delegation-only, and bind specialist jobs to configurable models through existing registry, preferences, transports, and account pools.

## Architecture

The routing policy accepts catalog, pricing, billing, and capacity snapshots and returns a decision. Harness launch hooks establish persistent job bindings before inference. Existing dispatch and pool modules execute those bindings, while an authenticated decision channel delivers launch and fallback notices.

## Stack and specification

Use the existing ESM TypeScript, Node 22, pnpm, Vitest, and tsup setup. The specification is [MODEL-ROUTING.md](../../MODEL-ROUTING.md). It owns category suggestions, configuration fields, role restrictions, economic rules, and fallback semantics.

## Global constraints

- Keep prices and availability in discovered/cached metadata. Keep product setup suggestions in data.
- Extend existing JSON preferences, registry, checkpoint storage, and account dispatch. Preserve routing-off behavior.
- Run GitNexus impact before every existing-symbol edit. Resolve UNKNOWN with exact-target CLI checks and source references.
- Run deterministic tests with `LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE=1`. Never run headless Claude.
- Preserve provider cache controls, authentication boundaries, required instructions, and replay safety.
- Keep the version unchanged and leave commits, pushes, and live evaluations for explicit user authorization.

## Review focus

| Failure condition | Expected behavior | Owning task |
|---|---|---|
| Native credentials contain an API key instead of subscription evidence | Show authentication and billing separately, never claim an OAuth subscription from a provider name | 2 |
| Claude Code resumes a child or retries its launch | Restore the model, effort, alternation arm, and selector budget | 4 |
| Two requests reach one binding during failover | A revision lease permits one inference request and prevents mixed-model execution | 4, 6 |
| A fallback starts a streaming response while notice delivery fails | Make no replacement provider call without the rendered-notice acknowledgment | 6 |
| Pricing omits one component or falls back to another platform | Retain unknown/provenance state and sort incomplete estimates last | 2, 3 |

## Files and ownership

| File or existing surface | Responsibility |
|---|---|
| New `src/model-routing.ts` | Domain references, snapshots, decisions, deterministic eligibility and cost ordering |
| New `src/routing-config.ts` | One routing-preferences validator, setup suggestion resolution |
| New `src/routing-selector.ts` | Same-tier selector, measured-cost gate, semantic cache, per-job call budget |
| New `src/routing-bindings.ts` | Launch idempotency, stored bindings, alternation, revision leases and resume |
| New `src/proxy-routing-control.ts` | Authenticated launch, decision subscription, and notice acknowledgment operations |
| New `src/patch-transforms-model-routing.ts` | Narrow harness launch/prompt/role hooks using existing scope discovery |
| New `src/cli-command-switchyard.ts` | CLI/submenu setup, categories, status, cost overview, enable and disable |
| Existing `src/config.ts`, `src/types.ts` | Persist routing through the current preference whitelist and lock |
| Existing registry/auth/pricing modules | Billing evidence, native Claude catalog references, complete cost provenance |
| Existing patcher/picker/notice modules | One visible entry, selected-model metadata and rendered notices |
| Existing proxy, native, SDK and checkpoint modules | Resolve bindings through current transports and execution safety |

Do not split the new routing modules further unless an implementation exceeds the repository's enforced limits. Keep existing files intact outside the required routing changes.

## Task 1. Add validated preferences with an unchanged disabled path

Files include `src/routing-config.ts`, `src/model-routing.ts`, `src/types.ts`, `src/config.ts`, and `tests/model-routing-config.test.ts`.

Interfaces comprise `ModelRef = { providerId: string; modelId: string }`, `RoutingConfig`, and `parseRoutingConfig(value: unknown): RoutingConfig | undefined`. An absent value returns undefined. Invalid explicit configuration throws an error naming its JSON preference path.

- [ ] Run exact-target impact for `UserPreferences`, `loadPreferences`, and `savePreferences`, inspect direct callers, and report risk before editing.
- [ ] Write configuration tests with `expect(loadPreferences().routing).toBeUndefined()` for legacy preferences, round-trip assertions for every routing field, and `expect(() => parseRoutingConfig(invalid)).toThrow('routing.')` for malformed references, effort, loops, and selector bounds.
- [ ] Run `LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE=1 pnpm exec vitest run tests/model-routing-config.test.ts tests/config.test.ts` and confirm the new behavior fails before implementation.
- [ ] Implement schema validation and whitelist persistence, including role-specific fallback chains, serving alternatives, evaluation evidence, and two deep-research arms. Preserve unrelated preferences under the existing write lock.
- [ ] Repeat the focused command and run `pnpm typecheck`. Require passing assertions and zero type errors before Task 2.

## Task 2. Resolve billing, costs, and native Claude through the registry

Files include `src/registry/types.ts`, `src/registry/io.ts`, `src/registry/account-schema.ts`, `src/registry/import-build.ts`, `src/registry/pricing.ts`, `src/registry/fetch-template-models.ts`, `src/provider-catalog.ts`, existing native-auth readers, and new `tests/model-routing-catalog.test.ts`.

`CostSnapshot` and `RoutingCatalogSnapshot` define the data boundary. `buildRoutingCatalog(input: CatalogSnapshotInput): RoutingCatalogSnapshot` builds that view in `src/model-routing.ts`. Input contains existing registry/catalog records, pricing data, authenticated credential-source descriptors without secrets, observed pool capacity, and a clock. The snapshot contains concrete references, capability confirmation, billing evidence, and price completeness/provenance.

- [ ] Run impact for each parser/import/pricing function selected for editing. Reuse credential readers without changing their refresh or storage contracts.
- [ ] Write fixtures asserting unknown billing for legacy entries, API-key subscription evidence, native OAuth versus native API-key distinction, API-provider isolation, incomplete pricing, cache-rate retention, and alternate-platform provenance. Assert `expect(snapshot.models.find(isIncomplete)?.estimate.kind).toBe('unknown')`.
- [ ] Run the new catalog tests with `tests/fetch-template-models.test.ts`, `tests/anthropic-models-fetch.test.ts`, and `tests/provider-keychain-reads.test.ts`, and confirm the missing behaviors fail.
- [ ] Extend the existing registry metadata and import path for the native credential reference. Resolve native models from harness/account metadata with source confirmation. Build snapshots from existing price data without changing legacy price consumers when routing is off.
- [ ] Repeat the focused tests and typecheck. Require native discovery fixtures to resolve a real `ModelRef` without a static availability assertion.

## Task 3. Implement deterministic selection and bounded same-tier selection

Files include `src/model-routing.ts`, `src/routing-selector.ts`, `tests/model-routing-policy.test.ts`, and `tests/model-routing-selector.test.ts`.

Interfaces comprise `decideRouting(input: RoutingPolicyInput): RoutingDecision` and `selectRoutingTie(input: SelectorInput, dependencies: SelectorDependencies): Promise<RoutingDecision>`. Dependencies supply a clock, abortable provider call, session cache, and atomic per-job call reservation. No policy code opens credentials or creates provider clients.

- [ ] Write policy assertions for explicit-target precedence, hard errors on unresolved targets, runtime price ordering, unknown-last ordering, capability/effort filtering, stable tie order, and snapshot repricing. Assert `expect(decision.target).toEqual(configuredTarget)` and `expect(ordered.at(-1)?.estimate.kind).toBe('unknown')`.
- [ ] Write selector tests for timeout, invalid selection, wrong cost tier, empty/stale evaluation evidence, shared signature cache across jobs, and concurrent budget reservation. Assert one upstream selector call at most and equality with deterministic output after failure.
- [ ] Run `LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE=1 pnpm exec vitest run tests/model-routing-policy.test.ts tests/model-routing-selector.test.ts` and confirm the new cases fail.
- [ ] Implement category/effort resolution before calls, measured-token break-even checks, compact signatures, semantic cache keys, and the default one-call budget. Connect through existing provider dispatch interfaces and count fallback attempts against that budget.
- [ ] Repeat both suites and typecheck. Inspect captured selector payloads to confirm they contain no full user prompt, source files, credentials, or worker tools.

## Task 4. Prove one bound specialist request end to end

Files include `src/routing-bindings.ts`, `src/proxy-routing-control.ts`, `src/patch-transforms-model-routing.ts`, existing checkpoint modules, `src/patcher.ts`, picker/notice transforms, `src/proxy-handler.ts`, `src/http-proxy/routing-decision.ts`, `src/proxy-messages-handler.ts`, `src/proxy-native-handler.ts`, and `src/proxy-sdk-handler.ts`. Add `tests/model-routing-bindings.test.ts` and `tests/model-routing-integration.test.ts`.

Interfaces comprise `createRoutingBinding(input: BindingLaunchInput): Promise<RoutingBinding>`, `resolveRoutingBinding(input: BindingRequestInput): Promise<RoutingBinding>`, and `withRoutingLease<T>(input: LeaseInput, action: (binding: RoutingBinding) => Promise<T>): Promise<T>`. All share existing checkpoint/CAS persistence. `handleRoutingControlRequest(req, res, context): Promise<boolean>` follows the current context-selection handler pattern.

- [ ] Enumerate touched existing symbols, run impact, and report HIGH/CRITICAL results. Keep routing disabled until the entire slice passes.
- [ ] Write launch/resume/concurrency fixtures and patched-harness tests. Assert one `auto` picker option, an unchanged routing-off picker, stable child model/effort and context metadata, idempotent A/B allocation, restored selector budgets, and retryable conflict on overlapping inference.
- [ ] Write loopback transport assertions for both SDK and native Claude paths. Assert `expect(capturedRequest.model).toBe(configuredUpstreamModel)` and client responses retain the binding identity. Reject cross-session, missing, forged, and expired bindings.
- [ ] Implement hidden identities, launch control, persistence, and lease handling before normal route lookup. Extend native passthrough to resolve credentials from the binding and write the concrete outbound model. Keep existing pool ranking and failover, adding only an optional pure eligibility constraint before reservation and after registry reload.
- [ ] Run both new suites plus `tests/http-proxy-routing-decision.test.ts`, `tests/http-proxy-native-model-routing.test.ts`, `tests/patch-model-picker-options.test.ts`, and the current harness picker fixtures. Then run typecheck.

The task ends with the first working vertical slice. Do not add general selector/UI features to compensate if the supported harness cannot carry the binding or capability metadata. Resolve that seam first.

## Task 5. Enforce router delegation and stable specialist prompts

Files include `src/patch-transforms-model-routing.ts`, existing tool-search and request-translation modules, `tests/model-routing-prompts.test.ts`, and `tests/model-routing-harness.test.ts`.

Add `prepareRoutingPrompt(input: RoutingPromptInput): RoutingPromptResult` in `src/model-routing.ts`. Input contains role, category, stable instructions, original task, required constraints, tools, job state, and provider identity requirements. Output retains required instructions and tool-result meaning without unrelated parent history.

- [ ] Write fixtures that capture router and specialist requests. Assert the router can delegate but cannot invoke edit/shell/code tools, the original task reaches its worker unchanged, and specialists retain required constraints and job state.
- [ ] Add multi-turn prefix equality assertions and native OAuth identity tests. Assert `expect(second.prefix).toEqual(first.prefix)` and compare preserved `cache_control`, TTL, session identity, tools, and tool results.
- [ ] Run the new suites and `tests/neutral-subagent-request.test.ts`, `tests/neutral-anthropic-request.test.ts`, and `tests/reasoning-signature-provenance.test.ts` to establish failures before edits.
- [ ] Implement role restrictions at both tool exposure and execution boundaries. Apply stable specialist instructions at child launch and preserve the existing native authentication/prompt boundary.
- [ ] Repeat focused verification and typecheck. Record the user-run interactive capture still needed to prove the installed harness's final prompt.

## Task 6. Add observable fallback and acknowledgment before dispatch

Files include `src/routing-bindings.ts`, `src/proxy-routing-control.ts`, the existing notice/harness transforms and inference log modules, plus `tests/model-routing-fallback.test.ts` and `tests/model-routing-notices.test.ts`.

Interfaces comprise `advanceRoutingFallback(input: RoutingFallbackInput): Promise<RoutingBinding>` and `awaitRoutingNotice(input: NoticeAcknowledgmentInput): Promise<void>`. The latter uses the authenticated session decision subscription and rendered-revision acknowledgment, with a bounded deadline and parent cancellation.

- [ ] Write tests for missing credentials, rejected credentials, pool quota/credit exhaustion, selector timeout, role-specific chains, and exhausted fallbacks. Assert selected outbound model, reason log, notice revision, and no repeated model reference.
- [ ] Write streaming fixtures asserting `expect(replacementCalls).toHaveLength(0)` before acknowledgment and after acknowledgment timeout. Assert no replay after output/tool emission and no binding transition without the owning lease.
- [ ] Run both new suites with `tests/account-pool-credit-failover.test.ts`, `tests/account-pool-proxy-capacity.test.ts`, and execution-recovery fixtures, and confirm new behaviors fail first.
- [ ] Implement separate router/selector/worker chains around existing dispatch outcomes. Persist each transition, deliver and acknowledge its notice, then dispatch through the authorized target. Reuse existing capacity observation and error classification.
- [ ] Repeat verification and typecheck. Require correlated decision/usage logs with unknown costs intact and no prompt, response, signature, or credential leakage.

## Task 7. Add Switchyard CLI and submenu configuration

Files include `src/cli-command-switchyard.ts`, `src/cli.ts`, `src/cli-args.ts`, `src/cli-help.ts`, existing provider/menu surfaces, `src/routing-config.ts`, and `tests/cli-command-switchyard.test.ts`.

Expose `runSwitchyardCommand(args: string[]): Promise<number>`. Reuse the existing preference writer, catalog, pricing snapshots, and patch reconciliation. Interactive setup and noninteractive commands share the validator.

- [ ] Write CLI tests for enable, disable, status, costs, category targets/effort, two research arms, missing credentials, unsupported harness anchors, and unresolved targets. Assert `price unknown` sorts last and disabling preserves unrelated preferences.
- [ ] Write setup fixtures for users with API-only, subscription-only, mixed, or unknown billing. Assert no dependence on personal aliases, no invented subscription prices, and no comparison of incompatible quota units.
- [ ] Run the new suite with `tests/cli-command-models.test.ts` and CLI parsing/help fixtures, and confirm the missing surface fails.
- [ ] Implement `leverframe switchyard` commands and the submenu. Show detection, category choices, billing policy, cost provenance, active-job timing, and a routing notice. Validate discovery and patch readiness before enabling.
- [ ] Repeat focused tests and typecheck. Confirm unavailable plan metadata produces an unknown comparison rather than an unsupported cheaper-subscription recommendation.

## Task 8. Complete regression, package verification, and review

Files include the routing suites, supported Claude Code harness fixtures, and `docs/MODEL-ROUTING.md`. Update provider/transport contract documentation only for the new routing/native binding behavior.

- [ ] Audit every acceptance requirement against a named test, including routing-off equivalence, outbound model/effort, missing credentials, unknown prices, selector timeout, cache preservation, resume, concurrency, and visible fallback.
- [ ] Run `pnpm typecheck`, `pnpm lint`, `LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE=1 pnpm test`, and `pnpm check:package`, retaining their complete outputs. If package verification needs fresh build artifacts, run the existing build first and repeat package verification.
- [ ] Run graph change analysis on this checkout with `node .gitnexus/run.cjs detect-changes --scope all --repo .`. Resolve partial/truncated output and inspect affected processes. No commit follows without user authorization.
- [ ] Review the whole diff for a second config/registry/dispatcher, hard-coded prices/availability/rankings, forbidden Claude invocations, leaked secrets, and changes outside routing.
- [ ] Hand over a tested implementation summary, remaining interactive verification steps, and one paragraph of unverified behavior. Keep claims bounded by the checks that ran.

## Current graph checkpoint

An index-only force rebuild completed without changing source or project instructions. Exact file/kind CLI lookups now provide usable results, while MCP still reports partial UNKNOWN results. Use the CLI fallback for source edit gates and inspect every final touched symbol independently.

| Symbol | Current CLI result | Caller/process scope |
|---|---|---|
| `loadPreferences` | CRITICAL, exact, 70 affected symbols, 21 direct callers | Launch, patch reconciliation, HTTP proxy, server and pool dispatch, 18 grouped processes |
| `applyModelPickerOptions` | HIGH, exact, three affected symbols, one direct caller | `applyConfiguredModelPicker`, patch transaction process |
| `decideHttpProxyRoute` | LOW, exact, two affected symbols, one direct caller | `handleMitmRequest`, MITM request process |

These results warn about shared-surface risk. They do not authorize edits to other symbols without their own impact checks.

## Execution handoff

The user chose Terra at high effort for implementation and Luna at max effort for QA. A fresh implementer and reviewer handle each task, with a trusted test writer owning test edits. Tasks 1 through 3 passed their task reviews. Task 4 remains in progress, with its exact evidence and open gates in the private execution ledger. Development checks use temporary homes and injected credentials. No task authorizes headless Claude, live account changes, commits, pushes, or a version change.
