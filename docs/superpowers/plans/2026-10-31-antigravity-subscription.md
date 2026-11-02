# Antigravity Subscription Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for native execution or superpowers:subagent-driven-development if the user selects delegation. Track implementation with the checkboxes below. This document authorizes no implementation by itself.

**Goal:** Connect Leverframe's patched Claude Code harness to account-discovered Gemini models using existing Antigravity subscription allowance and browser login.

**Architecture:** Add an OAuth-only `antigravity` provider behind the existing model factory. Use `@ai-sdk/google@4.0.12` for Gemini serialization with a Leverframe HTTP adapter that owns subscription authentication, envelopes, SSE unwrapping, and credit rejection. Claude Code keeps its agent loop and information harness.

**Tech Stack:** TypeScript, Node.js 22+, AI SDK 7, Google provider 4.0.12, Vitest, existing keyring and registry.

**Spec:** [Proposed integration direction](../../ANTIGRAVITY-INTEGRATION-DESIGN.md). Read [the source evidence](../../ANTIGRAVITY-SUBSCRIPTION-RESEARCH.md) before implementing Task 1.

## Global constraints

### Product and billing

- Preserve Claude Code's model picker, context handling, tools, compaction, and subagents.
- Supply browser login and direct subscription inference without a Google app, CLI, SDK agent, lazy installer, API key, or separately billed provider.
- Omit both credit-field spellings. Never retry with credits, another account, another model, or a paid endpoint.
- Keep account catalog IDs provider-qualified, for example `leverframe:antigravity:<upstream-id>`.
- Preserve the full instruction harness while normalizing Claude Code identity statements before model dispatch.
- Implement the proposed single-account, Gemini-only scope. Quota exhaustion returns an error without substitution unless the user changes that decision.

### Execution and verification

- Never run headless Claude, including smoke tests and wrappers. Use deterministic network fixtures and leave interactive Claude verification to the user.
- Keep current user edits in `src/patch-transforms.ts`, native repacking, tests, and `dist/` intact. Build and package verification in an isolated implementation checkout.
- Run GitNexus impact before source edits. Repair or refresh the index and rerun partial/UNKNOWN results, then confirm unresolved callers with source. Warn on HIGH/CRITICAL risk. Run complete graph change analysis before each commit.

## Review focus

| Input or failure | Expected behavior | Owner task |
|---|---|---|
| Account/project changes with the same token | Refresh coherent auth state or reject account mismatch | 2, 4 |
| Caller or retry injects credits | Reject the request before sending it | 1, 4 |
| Large tool signature followed by restart | Restore from private scoped state or fail resume | 5 |
| SSE splits UTF-8, contains errors, or disconnects | Preserve output and terminate without success fabrication or replay | 4, 6 |
| Stale catalog, missing limits, or verification-required account | Preserve uncertainty and return the actual provider failure | 3, 6 |

## Source map and graph status

| Responsibility | Existing seam | New files |
|---|---|---|
| OAuth registration and refresh | `src/oauth/types.ts`, `src/oauth/refresh.ts`, `src/registry/provider-auth.ts` | `src/oauth/antigravity.ts` |
| Coherent request-time auth | `src/env.ts:236`, `src/registry/import-build.ts` | `src/antigravity/auth.ts`, `types.ts` |
| Account discovery and catalog | `src/provider-templates.ts`, `src/registry/refresh-models.ts` | `src/antigravity/discovery.ts`, `models.ts` |
| Model factory and transport | `src/language-model-factory.ts`, `src/server/route-helpers.ts` | `src/antigravity/provider.ts`, `backend.ts`, `envelope.ts`, `response.ts`, `billing-policy.ts` |
| Request and response contracts | `src/sdk-request-translation.ts`, `src/sdk-streaming-response.ts`, `src/sdk-non-streaming-response.ts` | `src/antigravity/signatures.ts`, `request-context.ts` |
| Picker and routes | `src/catalog.ts`, `src/patcher.ts`, `src/http-proxy/routing-decision.ts` | Fixture coverage, no new patch transform expected |

Each later task owns its listed files, including the new paths under `src/antigravity/`. Keep types with their callers. The integration needs no generic provider framework.

Although the October 30 graph matches HEAD `75bbbd6`, it omits current edits and returns partial UNKNOWN impacts for `authenticateProvider`, `refreshStoredOAuthCredential`, `createLanguageModel`, `translateRequest`, `writeAnthropicStream`, and `buildCatalogRoutes`, so refresh it before implementation. Source confirms callers.

## Task 1. Pin the subscription envelope and disabled-credit contract

**Files:** Create `src/antigravity/types.ts`, `src/antigravity/envelope.ts`, `tests/antigravity-envelope.test.ts`, and `tests/fixtures/antigravity/` protocol fixtures. Extend the research note with actual evidence as it arrives.

**Interfaces:** `AntigravityAuthSnapshot = { accessToken: string; accountId: string; projectId: string }`. `buildAntigravityEnvelope(input: { modelId: string; projectId: string; sessionId: string; request: Record<string, unknown> }): Record<string, unknown>` returns a fresh envelope. Use the pinned shunt/Noe envelope and Google credit omission evidence from the research note.

- [ ] Write tests with literal subscription requests and responses. Assert both credit-field spellings are absent from outer and inner request objects. Assert credit-enabling protocol input throws, and ordinary tool arguments containing the same words remain untouched.
- [ ] Run `pnpm exec vitest run tests/antigravity-envelope.test.ts` and confirm the missing implementation causes failure.
- [ ] Implement allowlisted envelope construction. Carry account project, exact model, session, request ID, and only source-verified protocol metadata. Keep Google client registration constants out of docs and fixture output. Never invent paid-routing fields or dummy signatures.
- [ ] Run the test again, then review the exact outgoing JSON. Record the distinction between local omission guarantees and unverified backend billing semantics.
- [ ] Commit only this task after source impact, review, and complete graph change analysis.

**Completion:** Deterministic wire tests pin credit omission and rejection. Direct exhausted-quota behavior remains an open release condition, not a reason to simulate a paid retry.

## Task 2. Add browser OAuth and coherent request-time credentials

**Files:** Create `src/oauth/antigravity.ts`, `src/antigravity/auth.ts`, and `src/antigravity/discovery.ts`. Modify `src/oauth/types.ts`, `src/oauth/refresh.ts`, `src/registry/provider-auth.ts`, and `src/provider-templates.ts`. Create `tests/antigravity-oauth.test.ts` and `tests/antigravity-auth.test.ts`.

**Interfaces:** `runAntigravityOAuthFlow(options: { signal?: AbortSignal; openBrowser: (url: string) => void }): Promise<StoredOAuthCredential>`. `refreshAntigravityAccessToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthTokenResponse>`. `resolveAntigravityAuth(expectedAccountId?: string, options?: { signal?: AbortSignal }): Promise<AntigravityAuthSnapshot>`. `discoverAntigravityProject(accessToken: string, signal?: AbortSignal): Promise<string>`.

- [ ] Write OAuth tests for PKCE/state, wrong state, one-use callback, denied consent, occupied callback port, 5-minute expiry, cancellation, token rotation, revoked refresh token, and browser failure with a printed authorization URL. Mock Google and browser boundaries.
- [ ] Write auth tests for a keyring OAuth record, expiry refresh, same-token project update, account mismatch, logout, corrupt metadata, and rejection of `LEVERFRAME_KEY_ANTIGRAVITY`. Assert no API environment fallback.
- [ ] Run `pnpm exec vitest run tests/antigravity-oauth.test.ts tests/antigravity-auth.test.ts` and confirm failures describe absent behavior.
- [ ] Add explicit Google branches before the existing non-Copilot login path can fall through to OpenAI. Reuse credential journaling, mutation locking, refresh single-flight, and keyring persistence. Store stable account ID and managed project in credential metadata. The resolver validates the OAuth record and returns token/account/project together, bypassing generic API overrides.
- [ ] Implement project discovery with 20-second calls and at most 60 seconds of cancellable onboarding polling. Validate operation identity and account state. Surface eligibility and verification failures without treating login as inference success. Do not create a separately billed Cloud project.
- [ ] Rerun the two tests and `pnpm typecheck`, then review and commit this task after complete graph change analysis.

**Completion:** Fixture login, discovery, refresh, and logout preserve coherent identity without external runtime execution. The provider registers OAuth only.

## Task 3. Populate the account model catalog and existing picker

**Files:** Create `src/antigravity/models.ts` and `tests/antigravity-models.test.ts`. Modify `src/registry/refresh-models.ts`, `src/registry/types.ts`, `src/registry/provider-auth.ts`, and `src/registry/load.ts`. Extend `tests/catalog.test.ts` and `tests/patcher-context-config.test.ts` only for the new provider.

**Interfaces:** `fetchAntigravityModels(auth: AntigravityAuthSnapshot, options?: { signal?: AbortSignal; fetchImpl?: typeof fetch }): Promise<CachedModel[]>`. Produce `npm: '@ai-sdk/google'`, `modelFormat: 'cloud-code'`, exact `upstreamModelId`, account-reported capabilities, and unconfirmed context limits when absent. Add optional `modelsCache.oauthAccountId: string` to `RegistryProvider`, requiring a matching auth snapshot before exposing Antigravity entries. Other providers keep their existing cache behavior.

- [ ] Write tests for Gemini suffix variants, tiered model IDs, absent/invalid limits, unsupported catalog entries, empty catalog, expired credentials, malformed bodies, and account isolation. Sign in as B after A, fail B discovery, and assert A models enter neither B's picker nor inference. Cover fresh and stored catalog readers, missing ownership metadata, and an account change outside the login flow. Assert unknown context stays undefined and no Gemini API price marks a model free.
- [ ] Add a picker fixture that starts with discovered models and reaches `buildDesiredPatchConfig`, asserting qualified model identity, display name, effort, and confirmed context only.
- [ ] Run `pnpm exec vitest run tests/antigravity-models.test.ts tests/catalog.test.ts tests/patcher-context-config.test.ts`, then implement catalog dispatch and update the existing OAuth discovery allowlist.
- [ ] Persist validated Gemini entries with their account ID through existing model-cache operations. Clear the Antigravity catalog on every successful explicit login before refresh. Preserve a failed-refresh cache only when ownership matches the current account, with an explicit diagnostic. Fresh and stored readers expose no Antigravity entries when they cannot establish ownership. Do not guess a removed model ID or treat a stale catalog as fresh availability.
- [ ] Rerun those tests and `pnpm typecheck`, then review and commit after complete graph change analysis.

**Completion:** The existing picker configuration receives account-derived models without binary patch-transform changes.

## Task 4. Connect the Google serializer to subscription HTTP

**Files:** Create `src/antigravity/provider.ts`, `backend.ts`, `response.ts`, and `billing-policy.ts`. Modify `src/language-model-factory.ts`, `src/server/route-helpers.ts`, `src/registry/provider-auth.ts`, `package.json`, and `pnpm-lock.yaml`. Create `tests/antigravity-http.test.ts`, `tests/antigravity-response.test.ts`, `tests/antigravity-factory.test.ts`, and `tests/antigravity-billing-policy.test.ts`.

**Interfaces:** `createAntigravityLanguageModel(input: { modelId: string; expectedAccountId: string; fetchImpl?: typeof fetch }): LanguageModel`. `createAntigravityFetch(input: { resolveAuth: () => Promise<AntigravityAuthSnapshot>; fetchImpl?: typeof fetch }): typeof fetch`. `unwrapAntigravityResponse(response: Response): Response`. Task 1 supplies envelope construction and Task 2 supplies fresh auth.

`billing-policy.ts` exports `assertAntigravityBillingAllowed(accountId: string): void`, `recordAntigravityCreditConsumption(accountId: string, payload: unknown): void`, and `clearAntigravityBillingLatch(accountId: string): void`. The first rejects a latched account, the second validates source-verified credit fields and persists a latch on positive consumption, and the third serves explicit user recovery. Store the latch under `LEVERFRAME_HOME/antigravity/billing/<account-hash>.json` with private, atomic writes. Fail closed on corrupt latch state.

#### Contract fixtures

- [ ] Write tests that run the actual Google provider against mocked subscription HTTP. Assert every request reaches `https://daily-cloudcode-pa.googleapis.com`, with bearer credentials and the verified RPC path. Assert redirects, public Gemini/Vertex origins, API-key headers, unknown operations, and ambient Google API keys never reach the network.
- [ ] Test token rotation and same-token project changes between calls on one cached model handle. Assert account changes reject the old catalog/handle. Test 401 before output, 403 eligibility, structured and ambiguous 429, and 5xx. A quota response must produce exactly one inference attempt and zero fallback attempts.
- [ ] Add positive `consumedCredits` JSON and SSE fixtures. Assert redacted immediate failure, persisted account latch, zero later inference/catalog network requests for that account after restart, and isolation from another account. Token refresh must not clear the latch. An explicit login may clear it only after the user reviews the recorded billing failure. Unknown credit fields do not count as evidence of zero spending.
- [ ] Test SSE frames split across chunks and UTF-8 code points, comments, multiple data lines, nested response wrappers, empty terminal events, error envelopes, size limits, and cancellation. Assert the 1 MiB event limit and existing stream deadlines.
#### Implementation and verification

- [ ] Run the four new test files, confirm failures, then add exact dependency `@ai-sdk/google@4.0.12`. Verify its provider 4.0.3 and provider-utils 5.0.7 compatibility through typecheck. Use `createGoogle` with explicit API-key bypass and a mandatory custom fetch, never default fetch. Keep network access injectable.
- [ ] Register an explicit `antigravity` factory branch before dynamic SDK loading. Return a Google language model with no agent loop. Pass `providerData: model.providerData` in the server factory path, and use the request-time resolver rather than captured tokens/projects. Build outgoing headers afresh and consume internal session headers before Google dispatch.
- [ ] Set Antigravity inference retries to zero. Allow at most one explicit pre-response auth refresh after a rejected token, with the existing credential lifecycle. Preserve cancellation and never replay a response that has emitted output or tools.
- [ ] Check the billing latch after resolving identity and before each service request. Observe credit metadata before unwrapping JSON/SSE, persist any violation, and fail the request. Integrate explicit recovery into the login flow without clearing the latch on refresh, process restart, or model reselection.
- [ ] Rerun the four tests and `pnpm typecheck`, then review and commit after complete graph change analysis.

**Completion:** Both factory callers obtain the same subscription adapter. Network fixtures prove that no API/default-fetch path can escape interception.

## Task 5. Preserve harness identity, sessions, and resumable tool signatures

**Files:** Create `src/antigravity/signatures.ts`, `src/antigravity/request-context.ts`, and `tests/antigravity-signatures.test.ts`. Modify `src/proxy-shared.ts`, `src/sdk-request-translation.ts`, `src/sdk-streaming-response.ts`, `src/sdk-non-streaming-response.ts`, `src/proxy.ts`, and `src/server/anthropic-inference-route.ts`. Extend `tests/neutral-subagent-request.test.ts`.

**Interfaces:** Add `ToolSignatureCodec` to `src/proxy-shared.ts` with `encode(rawId: string, signature?: string): string` and `decode(id: string): { rawId: string; thoughtSignature?: string }`. `createAntigravitySignatureCodec(scope: { accountId: string; sessionId: string }): ToolSignatureCodec` creates a scoped persistent codec. `buildAntigravityRequestContext(body: AnthropicRequest, expectedAccountId: string, sessionId?: string): Promise<{ sessionId: string; toolSignatureCodec: ToolSignatureCodec }>` validates account state, reuses the existing client session extractor, and uses a fresh UUID when the caller supplies no stable session. Missing stable identity cannot resume a scoped signature.

- [ ] Write tests for a 257-byte and a 4 KiB signature across encode, fresh module/process state, decode, tool result, and next request. Cover same raw tool ID in two accounts/sessions, corrupt files, missing references, concurrent writes, and 1000-entry/10-MiB bounds. Persist atomically with private file permissions. Refuse overflow instead of evicting active history references.
- [ ] Add optional `toolSignatureCodec` to translation options and `SdkCallParams`. Use it for request tool IDs and both streaming and non-streaming response IDs. Strip this internal field before `streamText` or `generateText`. The default codec stays unchanged for other providers.
- [ ] Add Antigravity request context in both proxy and server inference entry points. Forward its session via `x-leverframe-antigravity-session`, then remove that header in the custom fetch and set the verified envelope session field. Keep separate conversations separate even when they share a model handle.
- [ ] Extend the neutral-agent fixture with main and delegated harness-generated identities. Assert the Google request has neutral identity while retaining task rules, full system instructions, deferred tools, user text, and tool results.
- [ ] Run `pnpm exec vitest run tests/antigravity-signatures.test.ts tests/neutral-subagent-request.test.ts tests/antigravity-factory.test.ts`, implement the scoped codec wiring, and rerun. Preserve signatures in the force-stream non-streaming path, which currently reconstructs tool-call records without their metadata.
- [ ] Run `pnpm typecheck`, review every shared-boundary change, and commit after complete graph change analysis.

**Completion:** Main and delegated requests preserve the harness without its client identity assertions. Long signed tool calls survive restart or fail resume before an invalid request reaches Google.

## Task 6. Prove both inference paths and subscription failure isolation

**Files:** Create `tests/antigravity-proxy.test.ts` and `tests/antigravity-server.test.ts`. Extend `tests/antigravity-billing-policy.test.ts`. Modify production files only when these fixtures expose a concrete contract gap, after impact analysis.

**Interfaces:** Exercise existing proxy/server entry points using Tasks 2-5. Mock Google HTTP, credential storage, and browser access while keeping request translation, Google serialization, and returned Anthropic SSE real.

- [ ] Cover login-to-catalog-to-picker-to-inference, text completion, thinking, one native tool call/result/continuation, parallel tool IDs, compaction request, model error, resume, account revocation, and client disconnect. Include streaming and non-streaming requests through both proxy and server paths.
- [ ] Capture every network attempt under fixtures that preload Google API keys and credit-enabling environment/settings data. Assert neither credit-field spelling reaches Google, no API-key request occurs, and quota exhaustion leaves one attempt with unchanged model/account/origin.
- [ ] Verify a missing qualified model rejects locally instead of falling through to Anthropic. Verify no Google inference occurs after a missing/corrupt signature, account mismatch, malformed auth snapshot, or unknown operation.
- [ ] Test diagnostic output for credentials, prompt text, and echoed upstream secrets. Retain redacted provider identity, structured error reason, and reset time only when the backend supplies it.
- [ ] Run `pnpm exec vitest run tests/antigravity-proxy.test.ts tests/antigravity-server.test.ts tests/antigravity-billing-policy.test.ts` and the earlier Antigravity tests. Require success before review and complete graph change analysis.

**Completion:** Deterministic end-to-end fixtures prove routing and local billing policy, without claiming that a fixture proves backend accounting.

## Task 7. Verify packaging and collect interactive release evidence

**Files:** Extend `scripts/verify-package-contents.mjs` for Google runtime exclusions. Update `README.md`, `docs/TESTING.md`, the research note, and `THIRD_PARTY_NOTICES.md` if source reuse requires attribution. Add `docs/ANTIGRAVITY-VERIFICATION.md` with redacted outcomes and dates.

- [ ] Document browser login, account-derived picker models, quota reset behavior, and actionable errors. Provide no API-key or separately billed fallback for this provider.
- [ ] Verify the package includes the serializer dependency and no `agy`, Google agent SDK, copied Google executable, runtime installer, or lazy package fetch. Keep package checks offline with respect to inference. Run build checks only in the isolated implementation checkout so current `dist/` work survives.
- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check:package`, `git diff --check`, and the explicit Antigravity test files. Inspect chosen test entry points first. Do not invoke an unfiltered full suite or any live Claude smoke file.
- [ ] Have the user complete an interactive login and a text/tool turn in the patched harness. Observe the selected account model, tool ownership, full harness instructions, and redacted subscription request. Capture no credentials or private prompts in committed fixtures.
- [ ] When baseline allowance is already exhausted, verify an omitted-credit request rejects with quota and the credit balance remains unchanged. Record the overage setting and concurrent-session conditions. Do not enable credits or intentionally drain allowance for this check. Keep this row open if the condition is unavailable.
- [ ] Run final review and complete `detect_changes` analysis. A partial/truncated result requires another run or an explicit unresolved report, never a clean result. Commit only reviewed implementation files, without the user's unrelated changes. Publish no zero-overage guarantee until the live evidence supports the stated scope.

**Completion:** Package and deterministic checks pass, the user verifies the interactive harness, and the billing evidence supports release. Otherwise report the exact incomplete release row without substituting API billing.

## Plan self-review

The plan assigns every requirement and review-focus failure to a task, with shared type names matching across tasks. Proposed scope and timeout values live in the design, while the research note holds external claims and source links. Task 7 separates local correctness from live backend evidence. Planning involved no production edits, dependency installation, live account call, or model execution.
# Execution status

The main checkout now contains the implementation and deterministic fixtures from
`feat/antigravity-subscription`. The checklist preserves the
original planning sequence above. [Verification status](../../ANTIGRAVITY-VERIFICATION.md)
records remaining interactive checks and tooling limits.

The implementation keeps signature persistence at the Antigravity wire
boundary, including unsigned parallel calls. It avoids adding a codec to
shared SDK call parameters. The test-write gate requires a dedicated test
writer. Commits remain pending because the existing hook invokes a model.
