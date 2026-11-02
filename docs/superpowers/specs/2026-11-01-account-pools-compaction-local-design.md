# Account pools, compaction, and managed local inference

The user approved this design on 2026-11-01, including next-request exhaustion delivery. Implementation follows the three subsystem plans.

## Agreed requirements

### Accounts and request continuity

- Initial account pools cover Anthropic API credentials and the existing ChatGPT/Codex OAuth integration. Claude Code subscription credentials stay outside these pools.
- Load balancing and quota failover default to enabled. Existing terminal settings provide separate, easy off switches and display the active account and switch reason.
- Selection considers observed quota and usage, keeps sessions on healthy accounts, and rotates equally when capacity is unknown. A switch preserves provider, model, and billing type.
- Confirmed quota failures may trigger a bounded retry on another eligible account. Ambiguous failures and requests that have begun producing a response must not trigger automatic replay.
- When every eligible account exhausts its quota, the API error explains the failure and any confirmed reset time. Main agents and subagents receive the meaning through the existing API error contract.

### Context efficiency

- Deterministic context reduction comes first. Model-assisted summarization is opt-in, and paid summarization needs a user-set spending limit.
- Preserve user instructions, objectives, decisions, unresolved errors, tool boundaries, and references to original evidence. Validation failure retains the original request and reports the reason.
- Optimize the Anthropic API request path against current official guidance, starting with request construction, cache reuse, and token accounting.

### Local inference and execution team

- Leverframe manages local model downloads, startup, shutdown, idle unloading, and removal. Downloads require explicit action.
- The local catalog stays small and covers coding models and models suited to compacting messages for the main agents. Apple Silicon with MLX comes first, then Linux with NVIDIA GPUs.
- Coding workers use GPT-6.1 Terra at High. Independent QA uses Luna at Max.

## Existing foundations

The registry has provider-scoped identities and rejects duplicate built-in API entries. ChatGPT/Codex OAuth already signs in and routes requests through the Codex backend. Optional OAuth account IDs provide routing metadata, but do not form a multiple-account registry.

Quota errors and request token usage already have handling. Remaining quota, reset windows, and shared quota scopes do not yet have a structured state model. Token usage cannot stand in for remaining capacity.

`src/context/request-compaction.ts` validates summary coverage, request identity, tool topology, and token bounds. Its indexed callers are tests, and the existing closure plan deferred production integration. MLX hardware/profile selection and worker supervision also exist as foundations rather than a complete managed model provider.

The proxy extracts session IDs and returns JSON or SSE errors to the request caller. Parent-session and agent-role metadata helpers exist without production wiring. There is no channel for notifying an idle agent.

## Approach

Extend the existing registry, provider runtime, proxy, and terminal settings. Account selection belongs before credential binding and upstream dispatch. Compaction belongs before provider request translation so routes share the same validated context policy.

A separate proxy would need another authentication stack as well as duplicate stream handling and request translation. Independent endpoint entries alone would permit manual account selection but would not provide coherent quota pools or cross-process health. Extending the current proxy meets the agreed behavior with fewer moving parts.

## Accounts and capacity

Separate stable account identity from provider identity. Preserve existing configurations and secret references during migration, and preserve pinned account selection when the user disables balancing. User-added accounts join the configured pool explicitly. Credential discovery checks documented locations and offers import without silently adopting credentials.

Each capacity observation records its source, observation time, scope, and any confirmed reset or retry time. Unknown values remain unknown. Provider adapters interpret structured responses and documented telemetry, while the pool scheduler consumes provider-neutral observations. Account identifiers, model availability, and quota scope come from configuration or verified observations, never hardcoded user accounts.

Authentication failure needs its own state, separate from temporary rate limiting and quota exhaustion. Credentials can share quota. Associate shared buckets only when evidence supports them, and invalidate stale runtime bindings after account changes while retaining reusable credentials.

Processes sharing a Leverframe configuration need coordinated account selection and health updates. Reuse the existing locking infrastructure where suitable, with atomic state changes, bounded reservations, expiry after process death, and secret-free state. Do not use inferred balances as authoritative quota.

## Errors across agents

An exhausted account does not mean an exhausted pool. Try another eligible account only when the failure permits safe replay. An exhausted pool affects requests that depend on it, regardless of agent role.

Retain the existing upstream error contract and provider detail where safe. Explain pool exhaustion with attempted accounts and confirmed retry information. Pre-stream failures use the JSON error path. Failures after streaming begins use the existing SSE error path and do not replay the request.

All main-agent and subagent requests using an exhausted pool receive the pool error on their next request. Healthy streams already running continue. Healthy pools remain usable. Verified parent relationships may improve attribution, but pool enforcement does not depend on knowing agent names or roles.

Immediate notification to an idle agent requires a separate client integration. An API response cannot deliver an unsolicited message to an idle Claude Code agent through the current request-response plumbing. Idle-agent notification falls outside this design.

## Compaction and Anthropic requests

Integrate the existing context grouping, budget, summary planning, and request validator. Begin with deterministic changes that retain required evidence and valid tool pairs. Store retained evidence outside the outbound prompt with bounded lifecycle and references that Leverframe can resolve.

Distinguish source content from instructions in summaries. Preserve recent work and unresolved tool exchanges. Reuse summaries only when request identity and source coverage match. Bound model summarization input, output, time, and spend. Estimate cost before dispatch where supported, account for actual usage afterward, and block additional paid summaries when spending reaches the configured limit.

Verify current official Anthropic guidance before changing cache layout, retry policy, token counting, or headers. Record supported guidance and dates in the implementation evidence. Measure cache reads/writes and input/output tokens alongside latency and compaction overhead. Design account affinity and stable prompt prefixes together because frequent account changes or summary rewrites can reduce cache reuse.

## Managed local provider

Leverframe owns model selection, artifacts, runtime processes, and provider registration. MLX remains an inference dependency. Users do not need a separately managed inference application.

Catalog entries distinguish coding and compaction capabilities and pin model revision, artifact identity, quantization, license, memory requirements, validated context, tool support, and verification date. Choose exact entries from current publisher material and local validation. Newer releases do not replace installed models automatically.

Coding entries must pass tool-use and streaming checks through the Claude Code adapter. Shorter summaries alone do not qualify. Compaction entries must preserve required information while reducing tokens, and concurrent workers must respect a shared memory budget and unload safely. Explain hardware incompatibility before download.

Linux/NVIDIA follows the same provider and lifecycle contracts in a later platform stage. Platform-specific runtime code remains behind that boundary.

## Delivery and acceptance

1. Deliver account identity migration, multiple-account management, pool controls, capacity tracking, and safe balancing/failover for Anthropic API and ChatGPT/Codex.
2. Integrate deterministic compaction and audit the Anthropic API path, then enable bounded opt-in model summaries.
3. Deliver managed MLX coding and compaction models, followed by the Linux/NVIDIA runtime.

Each stage needs deterministic checks and independent QA before proceeding. Use fake upstreams and local fixtures for quota, authentication, retry, streaming, and migration cases. Default checks make no provider/model API calls and never run headless Claude.

Account acceptance covers shared quota scopes, unknown capacity, exhausted pools, reset recovery, concurrent requests and processes, disabled toggles, account removal, and no replay after ambiguous or streamed failures.

Compaction acceptance compares original and compacted representative coding sessions for instruction preservation, tool validity, task results, and net token savings including summary cost. Record baseline measurements before choosing a numeric reduction threshold. A shorter prompt alone is not a pass.

Measure summary overhead across the session that reuses it. Report main-agent tokens separately from local inference tokens, and include paid summary cost in the billed-cost comparison. A one-time summary need not recover its entire input cost on the first request, but the session benchmark must demonstrate the intended saving without hiding that overhead.

Local acceptance covers download cancellation, artifact verification, process cleanup, memory pressure, tool-use sessions, stream errors, summary quality, and removal. User-run interactive Claude Code checks cover behavior that deterministic fixtures cannot establish.

## Review boundary

The design review covers scope, delivery order, and next-request exhaustion delivery. Exact model catalog entries and provider telemetry capabilities require evidence gathering during planning. Unsupported telemetry remains unknown rather than becoming a fabricated balance or reset time.

Existing unrelated workspace changes remain outside this work. The user authorized implementation commits and pushes. Default verification still makes no provider or model API calls.
