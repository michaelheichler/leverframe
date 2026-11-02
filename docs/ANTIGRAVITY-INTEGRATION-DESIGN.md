# Antigravity subscription integration direction

Proposed implementation direction, 2026-10-31. The user requested investigation and a plan. Product implementation and live verification have not started.

## Intent and confirmed requirements

Leverframe supplies Google subscription models to its patched Claude Code binary. Claude Code retains context management, permissions, tool execution, compaction, and delegation. Leverframe owns browser authentication, model discovery, and direct HTTP inference.

- Use existing Antigravity subscription allowance.
- Require no API keys, separate inference billing, Google app, Google CLI, or runtime download.
- Keep the existing model picker and provider-qualified model routing.
- Normalize identity instructions that Claude Code generates for main agents and subagents, preserving the information harness.
- Preserve existing user work and the prohibition on headless Claude verification.

Evidence and pinned external sources live in [the research note](ANTIGRAVITY-SUBSCRIPTION-RESEARCH.md). Google excludes third-party subscription clients from its supported access. This design describes an unofficial protocol integration and makes no support or account-continuity promise.

## Proposed v1 scope

| Decision | Direction | Reason |
|---|---|---|
| Runtime ownership | Claude Code remains the sole agent executor | Preserves the requested harness |
| Provider identity | `antigravity`, OAuth only | Separates subscription credentials from Gemini API keys |
| Models | Account-discovered Gemini models | Matches the requested Gemini scope without claiming Claude/GPT support |
| Accounts | One signed-in account | Avoids account rotation and entitlement mixing |
| Exhaustion | Return quota error and reset time when supplied | User has not selected an exhaustion option, so propose no model substitution |
| Credit usage | Omit credit opt-ins and provide no paid retry | Matches the first-party disabled-credit serialization |
| Transport | `@ai-sdk/google@4.0.12` plus a Leverframe custom fetch adapter | Reuses Google serialization and existing signature contracts |
| Packaging | Install the library with Leverframe | Avoids runtime package installation and agent executables |
| API fallback | None | Separate billing would violate the requirement |

## Approaches considered

| Approach | Assessment |
|---|---|
| Antigravity CLI or SDK agent runtime | Reject, introduces another executor or runtime installation |
| Gemini API or Vertex adapter | Reject, changes the billing and setup model |
| Native AI SDK LanguageModel implementation | Viable alternative, requires maintaining more serialization and streaming code |
| Google provider library with subscription transport | Recommend, isolates the unofficial envelope while reusing tool and thinking serialization |

The library is a request serializer, not a Google agent. The subscription adapter must intercept every outgoing model request. It must never delegate an unrecognized operation to the public Gemini API or an SDK default fetch.

## Boundaries and domain vocabulary

| Term | Meaning |
|---|---|
| Auth snapshot | One validated access token, account ID, and managed project from the credential store |
| Account catalog | Exact model IDs and capabilities available to the signed-in account |
| Baseline allowance | Subscription quota, distinct from AI credits |
| Credit opt-in | A wire field that permits credit use after baseline allowance runs out |
| Signature scope | Account plus conversation identity for preserving opaque tool signatures |

Keep protocol details under `src/antigravity/`, OAuth under `src/oauth/antigravity.ts`, and registration at existing provider seams. Reuse credential locking and atomic writes. Do not broaden the generic runtime cache to model Google project state.

The factory returns the existing LanguageModel interface. Both `src/proxy.ts` and `src/server/route-helpers.ts` reach it. The latter must also pass `providerData`. Account discovery and inference share the same request-time auth resolver so cached model handles cannot freeze an obsolete token/project pair.

## Authentication and model flow

1. `leverframe providers auth antigravity` opens browser authorization with PKCE and a bounded loopback callback.
2. Validate OAuth state and exchange the code. Persist tokens through existing credential lifecycle operations, with account ID and managed project metadata.
3. Resolve the managed project through the subscription service. Poll onboarding only when the verified response requires it, with cancellation and a finite deadline.
4. Fetch the account catalog and store exact upstream IDs with the stable account ID. A new explicit login clears the old Antigravity catalog before discovery, and cache readers reject missing or mismatched ownership. Keep absent context limits unconfirmed. API prices and a paid plan name do not establish entitlement or zero marginal billing.
5. Feed that catalog into the existing picker patch configuration. Source changes to binary patch transforms are unnecessary unless a deterministic fixture proves otherwise.
6. On each inference request, reread the coherent auth snapshot, reject account mismatch, and use the selected account model. Do not accept API-key environment overrides.

The researched OAuth implementations reuse Antigravity's client registration, and no evidence establishes subscription entitlement for a new Leverframe registration. Keep source provenance with the implementation and credentials out of docs and logs. OAuth success does not prove eligibility.

## Request, stream, and identity contracts

The Google library serializes Gemini requests. The custom fetch validates the SDK operation, builds the subscription envelope, attaches bearer authentication, and sends it only to the pinned Google subscription origin. Rebuild headers from an allowlist. Consume internal session headers before the external request and reject redirects.

The SSE transform unwraps subscription response envelopes into Google response events without buffering the complete stream. Preserve UTF-8 boundaries, usage, finish reasons, tool arguments, thinking signatures, upstream errors, cancellation, and backpressure. A terminal error must not become a successful empty completion.

Call the existing instruction normalization before Google serialization, preserving tool descriptions, task rules, user code, and results while replacing harness identity text. Keep the rest of the system prompt. Verify wire requests for both main and delegated agents.

Google signatures must survive a tool turn and proxy restart, so add an optional codec at the existing translation/stream boundary and persist opaque signature references with private, atomic storage under account/session scope. Stop resume if a reference fails validation. The error must explain the missing history state, without substituting dummy signatures or sharing references across accounts.

## Billing and failure contract

- Build a fresh allowlisted envelope and omit `enabledCreditTypes` and `enabled_credit_types` from both outer and inner request objects.
- Omit unverified paid-routing fields. Receiving `paidTier` during discovery must not opt inference into credit use.
- Reject credit-enabling input rather than forwarding it. Read no Google runtime settings that could enable credit retries.
- Set Antigravity SDK inference retries to zero initially. Relay 429 without model, account, endpoint, or billing substitution.
- A pre-response authentication rejection may refresh once through the credential lifecycle. Never replay after output or a tool call has reached Claude Code.
- Treat quota summaries as display snapshots. Keep unknown quota unknown, and preserve structured backend reasons rather than calling every 429 exhausted allowance.
- Task 4 observes explicit consumed-credit fields before unwrapping responses. Unexpected positive consumption fails the current request and persists an account-specific latch that blocks further network requests across restarts. Explicit user re-authentication after reviewing the failure clears the latch. This detection cannot undo spending.

Release requires evidence that direct requests with credit opt-ins omitted stop at exhausted baseline allowance without debiting credits. The official CLI default and Code Assist source support this hypothesis. They do not prove every Antigravity backend/account-setting combination. Keep this release condition open until the user can verify it without enabling credits or intentionally draining allowance.

## Reliability defaults proposed for implementation

| Operation | Bound | Failure behavior |
|---|---|---|
| Browser callback | 5 minutes | Close listener and cancel login |
| Token exchange/refresh and discovery | 20 seconds per call | Return redacted provider error |
| Onboarding polling | 60 seconds total, 1 second interval | Stop with an actionable provisioning error |
| Inference | Existing stream lifecycle and cancellation | Abort upstream on client disconnect |
| Catalog/error bodies | 8 MiB / 64 KiB | Reject oversized responses |
| SSE event | 1 MiB | Reject malformed or oversized frames |
| Persisted signatures | 1000 entries or 10 MiB per session | Stop rather than evict references needed by history |

The plan proposes these local bounds. Google supplies no guarantee for them. Account changes partition catalogs and signature state. Logout invalidates the account's cached handles and signature access. The integration needs no new background service, queue, database, or provider framework.

## Verification and release evidence

Use deterministic fixtures through the real proxy and server translation paths. Cover OAuth state, token refresh, entitlement denial, exact catalog variants, neutral instructions, native tools, long signatures, restart, split SSE frames, disconnects, quota errors, and rejected paid fallback. Installation checks must prove no Google agent runtime or lazy installer enters the package.

Live verification belongs to an interactive user session. Record only redacted protocol fields and outcomes. The no-headless-Claude rule applies to tests, scripts, reviewers, and helpers. No broad test command may discover and launch a live Claude suite.

GitNexus currently reports partial UNKNOWN impact. Source confirms the relevant callers, so implementation must repair or refresh the index, rerun impact, and report unresolved coverage before changing shared functions. This planning work does not claim those functions are safe to edit.

The delivery order and exact interfaces live in [the implementation plan](superpowers/plans/2026-10-31-antigravity-subscription.md).
