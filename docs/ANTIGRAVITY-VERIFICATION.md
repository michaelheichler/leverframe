# Antigravity implementation verification

The main checkout now contains the subscription adapter from
`feat/antigravity-subscription`. Interactive backend evidence remains open.

| Requirement | Deterministic evidence |
| --- | --- |
| Browser login without a Google runtime | PKCE/state callback, token refresh, fixed origin, package checks |
| Account-owned Gemini picker | Catalog ownership persistence, account changes, model filtering, picker fixtures |
| Retain the harness | Local proxy and gateway fixtures preserve task instructions and tool history |
| Tool continuation | Scoped durable references, large signatures, restart, parallel signed and unsigned calls |
| Subscription routing | Envelope allowlists, API-key exclusion, no credit fields or alternate billing route |
| Quota and billing errors | One-attempt quota fixtures, bounded RetryInfo, consumption latch and explicit recovery |
| Streaming | Fragmented SSE, malformed and oversized frames, errors and cancellation fixtures |

Signature persistence lives at the Antigravity wire boundary. The adapter
restores call IDs and signatures before HTTP and records provider-observed
calls before SDK parsing. Missing or corrupt references fail locally.
Unsigned calls also receive durable references so SDK placeholders cannot
reach Google.

## Interactive release checks

- [x] Complete browser consent using this checkout's built CLI. Login and account catalog refresh succeeded on 2026-10-31.
- [x] Verify account models, patch the harness, and run interactive text inference. The user confirmed success on 2026-10-31 after the system-message ordering fix.
- [ ] Run an interactive tool call and continuation.
- [ ] Resume after restart and verify tool continuation.
- [ ] Confirm a revoked account requires login and stale account models cannot execute.
- [ ] If allowance is already exhausted, confirm an omitted-credit request rejects and credit balance stays unchanged. Record overage settings and concurrent sessions. Do not enable credits or drain allowance for this check.

The user completed live login and model discovery after implementation.
The user confirmed live text inference works. Tool inference verification remains open.
The first interactive text request failed because the Google serializer
rejects system messages after conversation messages. The Antigravity
model wrapper now moves all system entries to the beginning, preserving
instruction order and conversation content. Streaming and non-streaming
regressions reproduce the exact failure without the fix and pass with it.
The proxy-route fixture passes too, and the user confirmed that the rebuilt
interactive session works.
Local fixtures cannot establish backend billing for every subscription or
account setting. Leverframe makes no zero-overage guarantee.

## Tooling limits

The original workstream verified the package directly after the
`pnpm check:package` wrapper encountered npm `EALLOWSCRIPTS`, preserving
the package manager configuration. Both checks pass in the main checkout.

Final checks passed 215 tests across 26 explicit fixture files, type
checking, lint, build, direct package verification, and diff whitespace.
The package contains 12 files and no vendor agent runtime dependencies.

GitNexus reported 60 changed files, 1552 symbols, 145 affected processes,
and CRITICAL risk. Its output abbreviates symbol and flow listings even
after a larger limit. Earlier helper impacts included unresolved identities
and unrelated callers. Graph completeness remains unresolved. Source
checks and the independent review supplement that evidence.

The original workstream left commits pending because the pre-commit hook invokes
Caliber's model-backed documentation refresh. Implementation kept hooks
intact and avoided unrequested model calls. Original checkout changes
remain outside this worktree.

Main integration preserves the newer account pools, native Anthropic caching,
and ChatGPT session headers. Provider menus include Antigravity browser login,
and OAuth help lists all implemented sign-in providers.

The 2026-11-02 main integration passed 2792 tests across 335 files, plus
type checking, lint, build, package verification, and whitespace checks.
The run excluded live Claude suites and native-binary execution tests.
The installed CLI displayed Antigravity in its provider-add menu.
