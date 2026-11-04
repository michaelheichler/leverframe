# Model routing

The user accepted this design for implementation. The [implementation plan](superpowers/plans/2026-11-02-model-routing.md) records the work order and verification gates.

The evidence baseline is repository commit `a3f9040cfcde4a3d08f0e86d464409937874a97c`, inspected on 2026-11-02. The design applies to the product and does not depend on the developer's installed providers, favorites, aliases, or subscriptions.

## Product behavior and accepted decisions

When the user enables routing, Claude Code exposes one picker entry, `auto`. Leverframe retains its provider and model configuration and adds a Switchyard submenu with a visible routing notice. Disabling routing restores ordinary model selection.

The front router delegates work and never codes. Prefer the configured DeepSeek Flash target through OpenCode Go when discovery and credentials confirm it. Otherwise use Haiku 5.5 through the configured Claude subscription/API policy. Opus handles orchestration as a specialist.

Each specialist receives a task brief with required tool instructions and project/user constraints. Include the job state and its tool results. Keep unrelated parent history and unrelated Claude Code instructions outside that brief. Preserve provider-required identity and authentication behavior. Routing does not summarize or rewrite the user's task with an extra model call.

Resolve a specialist's category, model, and effort at launch and retain that binding until the job ends. A logged availability fallback may change its model, but category changes leave the binding intact. Resume restores that same binding.

Use explicit harness category configuration first. Deterministic inspection can fill a missing category for a verified specialist. Traffic without a verified specialist identity stays on the front router. Deep research alternates between separate jobs, with one model per job. Concurrent launches allocate their positions atomically when the authenticated routing service accepts each validated launch. This order precedes model-dependent prompt preparation and can differ from native concurrency-slot or execution-start order.

Category targets take priority. A category without a target uses the cheapest eligible model in the user's configured pool. Enable the optional LLM selector for ties within the same cost tier, with a default maximum of one extra call per job. The selector cannot generate code, rewrite a request, or choose outside that tier.

Add explicit economic billing metadata to the existing registry and preserve unknown values, because authentication type alone does not establish subscription status.

## Implemented handoff boundary

The front router exposes and executes only the native Agent delegation tool. Its stable instruction asks for the original user task, the assigned task, required constraints, tool instructions, attributed evidence and job state. The router supplies this material explicitly. Structural checks cannot establish that its brief contains every relevant fact, and evidence remains data rather than instruction authority.

For an ordinary local specialist launch, the authenticated loopback control service prepares a versioned envelope without calling a model, provider or selector and without allocating a binding. The native spawn hook reviews that envelope, and native permission checks remain in force. The launch action validates the reviewed envelope before creating a binding. It preserves the exact reviewed prompt as the child task and its binding digest.

New native specialist bindings retain the selected category, category provenance, model, effort and reviewed handoff. Private immutable handoff documents live in the existing checkpoint namespace, and the existing CAS index stores their content references. A failed CAS can leave an unreferenced private document. The system validates the reference and contents when it loads a binding, and it rejects an oversized index before writing it.

The reviewed envelope limit is 96 KiB, the projected prompt-policy limit is 128 KiB, and the authenticated routing control request limit is 1 MiB. Oversized inputs fail visibly without truncation. The extra prepare request stays on loopback and adds local launch overhead, which belongs in whole-task evaluation.

Ordinary local foreground and background specialist paths use this handoff. Active routing rejects teammate, remote, fork and restored interrupted callback launches when the native source exposes those modes. A missing or unidentified request context keeps the front tool restrictions. The sourced paths and deterministic fixtures do not establish every plugin, desktop, worker or remote execution path. Installed Claude prompt behavior still requires an interactive user capture.

Active and recovery-only resume keep the saved transcript rows in order and do not copy new parent intent into a bound specialist. If the original launch envelope is absent, the resume path adds one clearly labeled historical snapshot without replacing the existing transcript. An interrupted turn that lacks that original row or snapshot fails before inference because inserting a user row could break a pending tool exchange. A known older binding without a versioned handoff asks the user to start a new agent, while unbound recovery keeps native behavior. The retained-source fixtures cover these paths, and installed interactive behavior remains unverified.

Deterministic integration tests cover the fallback and CLI notice behavior described below. Installed interactive notice rendering remains unverified.

## Evidence from the pre-routing implementation

This section describes the inspected baseline before routing. The linked files have since changed.

### Request model path

1. An endpoint launch sets the canonical model through `ANTHROPIC_MODEL` and the launcher model argument. HTTP proxy launch leaves model selection with Claude Code. See [endpoint launch](../src/claude-endpoint-launch.ts#L35) and [HTTP launch](../src/claude-http-launch.ts#L88).
2. `loadHttpProxyRoutes` reads preferences, obtains a fresh catalog, filters compatibility, resolves credentials, and builds routes. `localModelToRoute` retains the upstream model as `realModelId`. See [route loading](../src/http-proxy/index.ts#L25) and [catalog conversion](../src/catalog.ts#L21).
3. External routes receive `leverframe:<provider>:<model>` identities and configured aliases. Native Anthropic subscription models bypass this external route table. See [route construction](../src/http-proxy/routes.ts#L57).
4. The HTTP server indexes identities. MITM parses `body.model` and chooses translation, native passthrough, rejection, or raw forwarding. See [route index](../src/http-proxy/server.ts#L58), [request parsing](../src/http-proxy/routing-decision.ts#L84), and [MITM dispatch](../src/http-proxy/mitm.ts#L94).
5. Adapter forwarding preserves the body and session header. `prepareProxyMessage` resolves the model again, selects pool handling, and applies request context policy. See [adapter forwarding](../src/http-proxy/forward.ts#L121) and [message preparation](../src/proxy-messages-handler.ts#L96).
6. Native dispatch writes `route.realModelId` into the outbound body. SDK dispatch constructs the upstream model using the same real id or delegates to the existing pool. See [native dispatch](../src/proxy-native-handler.ts#L35) and [SDK dispatch](../src/proxy-sdk-handler.ts#L121).

`request-pipeline.ts` currently handles disconnect abortion and execution disposal. It does not normalize model selection. `model-source.ts` classifies discovery methods, while refresh and endpoint discovery perform discovery. See [pipeline](../src/request-pipeline.ts#L9), [source classification](../src/registry/model-source.ts#L15), and [refresh](../src/registry/refresh-models.ts#L380).

### Picker, harness, and effort

Picker configuration comes from preferences, favorites, aliases, and registry/fresh-catalog metadata. The picker injection appends configured options to the native list. Providing one option does not replace that list. See [patch configuration](../src/patcher.ts#L239) and [picker injection](../src/patch-model-picker-options.ts#L23).

The harness fixtures resolve a child model before constructing its runner configuration. Child context links the agent identity to its model and includes effort permissions. The existing notice runs after launch acceptance and reports a static resolved choice. It does not receive proxy fallback events. See [child model resolution](../tests/fixtures/claude-agent-2.1.266.ts#L12), [newer child configuration](../tests/fixtures/claude-agent-2.1.280.ts#L7), and [notice insertion](../src/patch-transforms-routing-modern.ts#L83).

The proxy can set per-request effort. `translateRequest` reads `output_config.effort` before the route default, then maps effort through provider capability handling. Native forwarding preserves the request's effort. A launch pin can affect harness effort precedence, so the routing binding must own the child effort layer and its request field. See [request effort](../src/sdk-request-translation.ts#L298), [capability mapping](../src/reasoning-capability-detection.ts#L292), and [pin precedence fixture](../tests/patch-transforms-routing-notice-claude-2-1-266.test.ts#L89).

### Pricing sources

| Provider path | Source supported by current discovery | Consequence |
|---|---|---|
| Generic OpenAI-compatible endpoint | Optional endpoint `pricing` fields, including cache rates | Treat fields as available only when the response supplies them. [Parser](../src/registry/fetch-template-models.ts#L75) |
| OpenCode Go | Supplier metadata, models.dev provider metadata, then endpoint pricing | Retain source and usage-multiplier provenance. [Precedence](../src/registry/fetch-template-models.ts#L175) |
| z.ai coding plan | models.dev provider metadata and optional endpoint pricing | Treat this as fetched third-party metadata. [Template](../src/provider-templates.ts#L124) |
| Anthropic API | Identity and limits without prices | Shared pricing enrichment or configured registry cost metadata must supply estimates. [Model parser](../src/registry/anthropic-model-list.ts#L38) |
| OpenAI OAuth | Capabilities and limits without prices | Shared pricing can supply a reference API-equivalent estimate. [Model builder](../src/registry/openai-oauth-models.ts#L121) |
| GitHub Copilot | Policy, transport, and capability metadata without prices | Shared estimates do not establish subscription marginal cost. [Metadata](../src/copilot/model-metadata.ts#L140) |
| Antigravity | Subscription quota and limits without prices | Dedicated refresh does not run generic price enrichment, though global cache application can enrich it. [Catalog](../src/antigravity/models.ts#L27), [refresh](../src/antigravity/refresh-models.ts#L23) |

`PRICING_API_URL` is a constant URL. The user pricing cache takes precedence over the bundled cache, and remote refresh persists successful responses. Existing model costs take precedence over enrichment. The bundled cache currently holds three model records and cannot establish prices for the requested defaults. See [pricing source](../src/registry/pricing.ts#L18), [cache loading](../src/registry/pricing.ts#L99), [enrichment](../src/registry/pricing.ts#L199), and [bundle](../src/data/pricing-cache.json#L3).

Current conversion fills a missing input/output component with zero and drops shared cached-input rates. Platform lookup can fall back to another platform's row. Routing must retain completeness and provenance rather than interpret those results as confirmed complete provider prices. See [row selection](../src/registry/pricing.ts#L123) and [conversion](../src/registry/pricing.ts#L137).

### Authentication, billing, and account pools

Registry `authType` is `api`, `oauth`, or `none`. Pool `billingType` currently uses `api` and `oauth` and derives from authentication type. OpenCode Go demonstrates why this does not establish economic billing, because its subscription uses API-key authentication. See [registry](../src/registry/types.ts#L92), [pool key](../src/account-pool.ts#L6), [pool adapter](../src/account-pool-sdk.ts#L147), and [OpenCode template](../src/provider-templates.ts#L86).

The existing pool filters account catalogs, reserves capacity, resolves credentials, observes failures and capacity, and releases reservations. Missing credentials throw, and an observed authentication failure returns to the caller. Model fallback must handle those outcomes without replacing account selection. See [dispatchWithPool](../src/account-pool-dispatch.ts#L139).

Native `anthropic` denotes the Claude Code path, while `anthropic-api` denotes API-key billing. Native passthrough can obtain Claude Code credentials when the launch uses a placeholder. Resolve that path through the existing catalog/auth boundary and expose its billing evidence to routing. See [provider contract](PROVIDER-CONTRACTS.md#anthropic-api-key-provider) and [passthrough credentials](../src/http-proxy/mitm.ts#L70).

### Native Claude catalog binding

Keep `anthropic-api` separate from the native path. Extend the existing registry's reserved `anthropic` entry with a native Claude credential source that references the current credential reader and stores no copied token. Import detected native credentials through the existing provider-import flow, retain whether the credential is OAuth or an API key, and record subscription billing only when account evidence supports it.

Populate that entry's model cache from model identities and capability metadata reported by the installed harness or account discovery. Record the source and confirmation state. A generic family label or a static seed cannot establish account availability. If discovery cannot resolve the requested Haiku model, setup must show the unresolved reference and require a valid target before activation. Native discovery and import are necessary extensions to the current registry concern, and their exact supported harness anchors require fixture verification.

Resolve a native binding into a concrete model id plus the native credential-source reference. The adapter token stays internal. Extend the current native passthrough branch to accept that resolved binding even when the inbound model is `auto` or a hidden binding identity. Write the concrete model into the provider request, obtain credentials through the existing reader, preserve session identity and cache controls, and use the existing response-model echo machinery to retain the client binding identity. [Existing model echo](../src/upstream-forward.ts#L118)

### Prompt caching

| Path | Existing request controls | Routing requirement |
|---|---|---|
| Native Anthropic OAuth | Preserved Messages body, inbound beta/version headers, Claude session identity | Retain required identity and cache markers. [Forwarding](../src/upstream-forward.ts#L201) |
| Anthropic API and compatible Messages | `cache_control` markers and TTLs, subscription-only scope removal, filtered OAuth beta headers | Reuse current normalization. [Cache settings](../src/anthropic-sdk-cache.ts#L99), [headers](../src/upstream-forward.ts#L27) |
| OpenAI SDK | Stable `promptCacheKey`, metadata-gated explicit breakpoints, supported prompt-cache options | Keep prompt bytes, tools, and keys stable after binding. [Translation](../src/sdk-request-translation.ts#L258) |
| ChatGPT OAuth | Stable session-derived cache key and `session-id` header, existing conversation continuation | Preserve account affinity and existing continuation checks. [Session headers](../src/sdk-request-translation.ts#L270) |
| OpenCode Go | `x-opencode-session`, compatible cache usage extraction | Preserve session identity and read/write usage partitions. [Headers](../src/opencode-go-headers.ts#L4), [usage](../src/compatible-cache-usage.ts#L21) |
| Antigravity | Internal session header becomes backend session identity | Keep its identity stable and use observed cached usage. This does not prove support for explicit cache creation. [Backend](../src/antigravity/backend.ts#L64) |

HTTP `Cache-Control: no-cache` on an SSE response controls transport caching. Provider-default prompt caching behavior remains unknown unless discovery or usage establishes it.

Anthropic documents that changing top-level effort invalidates cached message prefixes. Model failover also cannot promise reuse of another model's KV cache. The contract preserves prompt bytes and cache controls during ordinary operation and records the cache consequence of an authorized availability fallback. [Anthropic caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

## Architecture and alternatives

Keep one TypeScript process and the existing HTTP/server, registry, preferences, provider adapters, account pools, and checkpoint store. The routing policy consumes immutable catalog/cost/capacity snapshots and returns a decision. It does not own credentials or provider clients.

| Approach | Assessment |
|---|---|
| Reclassify and change models on every request | Reject. It can change a running specialist and cannot distinguish parent and child traffic from the current session UUID alone. |
| Bind router and specialists at harness launch boundaries, resolve each bound request through existing dispatch | Selected and implemented. It preserves a job's model, permits explicit categories, and supports logged failover through the harness binding contract. |
| Add an independent worker runtime or embed Switchyard's Rust implementation | Reject. It expands beyond routing and duplicates runtime responsibilities. |

Adopt Switchyard's configured pool/policy boundary and whole-task evaluation stance. Its Execution policy uses tool-outcome signals, while this product's accepted initial `execution` policy uses configured category targets and launch-time eligibility. Keep the policy identifier/version in telemetry so evaluations can compare later policies. [Switchyard](https://github.com/NVIDIA-NeMo/Switchyard), [evaluation](https://nvidia-nemo.github.io/Switchyard/tuning/)

### Domain model

| Type | Meaning and invariant |
|---|---|
| `ModelRef` | Immutable `{ providerId, modelId }` resolved through the existing catalog. A model family label is a setup suggestion and cannot authorize execution. |
| `Category` | A configured key, initially orchestration, planning, coding, qa, summarization, exploration, research, or deep_research. |
| `Policy` | A versioned deterministic selection rule over configured targets, eligibility, costs, and observed capacity, with an optional same-tier selector. |
| `RoutingDecision` | Job/binding id, decision revision, category, selected `ModelRef`, effort, policy/version, reason code, source, cost snapshot id, and fallback history. |
| `CostSnapshot` | Timestamped provenance, currency/unit, known price components, context tiers, cache rates, billing evidence, freshness, and completeness. Unknown components remain unknown. |
| `RoutingBinding` | Session-scoped router or specialist identity plus its decision and config revision. It contains a registry reference and no copied provider definitions or credentials. |

Selection consumes plain snapshots from catalog/auth. Account dispatch and harness presentation retain separate boundaries, while existing adapters translate a decision into provider requests. Keep the existing registry and pool dispatcher as the owners of their responsibilities.

### Harness binding contract

Extend the existing authenticated loopback control surface with a launch-decision operation. The current context picker already uses that surface. [Existing control call](../src/patch-transforms-picker.ts#L502)

The harness sends session identity, an idempotent launch id, role, explicit category or agent type, a bounded task signature, and required request capabilities. The service returns an opaque binding identity, selected model metadata, effort, and a decision revision. Validate category and effort before any selector or worker call.

Use a hidden internal model identity carrying the binding id for specialist requests. Only `auto` enters the user picker. Resolve the hidden identity before normal route lookup and preserve it as the client-facing response identity. This gives the proxy a job identity without guessing from shared session metadata. A forged, expired, cross-session, or unknown binding fails visibly.

The native runner keeps the selected concrete policy model for its existing restriction checks and capability lookup. Carry the opaque binding separately until the final request constructor. The main public identity is an exact alias of the frozen preflight router, with confirmed metadata from that same snapshot. Reject native model substitution before dispatch, and compare the actual adapter route with the binding identity before resolving credentials.

Project confirmed specialist metadata from that same catalog into the existing routing patch configuration, including targets outside saved favorites. Native preparation must use the selected target's context, output limit and exact supported effort set. Preserve unrelated native metadata and omit unknown fields. If neither the host nor the sourced native catalog supplies limits that preparation requires, fail before starting that specialist.

For shared account models, preparation uses conservative minimum confirmed limits and the union of confirmed effort choices. Each binding fixes its effort and restricts serving accounts accordingly. An absent configured effort means provider default, so routing removes inbound effort overrides and suppresses route defaults. Proxy dispatch still requires registry-confirmed context. Native preparation facts alone do not turn an unknown host capability into a confirmed one.

Recovery must scope metadata to its verified child, preserving ordinary main requests that use the same concrete model. A built-in async context may carry one binding's immutable metadata through preparation and iterator execution. Use `run` and scope iterator advancement and cleanup explicitly. Node documents callback/promise propagation, while Bun excludes several worker and message-event boundaries. Gate unsupported transfers instead of assuming propagation. [Node 22 async context](https://nodejs.org/download/release/v22.21.0/docs/api/async_context.html), [Bun compatibility](https://bun.sh/docs/runtime/nodejs-compat#nodeasync_hooks)

Bindings also pin a nonsecret transport fingerprint alongside the upstream model and credential source. Derive it from existing route materialization for the canonical upstream endpoint and SDK/wire format. Exclude account identifiers and credential headers. Remove URL userinfo and fragments before hashing, and retain query semantics only inside the opaque digest. Query changes conservatively invalidate a resumed binding, including credential rotation through URL query parameters. Header-based token rotation leaves transport identity unchanged. A changed fingerprint requires the original configuration or a new job.

Apply the decision before constructing the child runner, including its effort permission layer and context limits. The current notice insertion is too late for selection. Preserve existing sandbox and permission enforcement. Restrict the front router's exposed and executable tools to delegation and necessary task control. Reject edit/shell/code actions from the router at the tool boundary.

The front router delegates work to a specialist and supplies the original task unchanged alongside the assigned task and relevant state. The selector does not rewrite tasks or produce work artifacts. Deterministic category inspection applies only after the harness identifies a specialist. It matches configured category names as whole token sequences and uses the configured default when matches are absent or ambiguous.

Record binding metadata with existing execution/checkpoint state. Persist launch allocation and the deep-research counter with the existing lock/CAS facilities before acknowledging launch. Resume restores the same allocation and selector budget. A duplicate launch request returns the previous binding without consuming a counter position or another selector call. Missing resume state produces an actionable recovery error.

Create the stable harness child identity once before model-dependent prompt preparation and reuse it at native launch. Keep native permissions, concurrency acquisition, and worktree cleanup in their existing order. A cancellation or rejection after routing acceptance consumes its allocated position and any reserved selector budget. Do not rewind the counter. An accepted job that never reaches inference retains its binding until expiry, and whole-task evaluation includes its optional selector overhead.

Allow one active inference request per job binding. Acquire a revision lease through existing CAS state, release it on completion/cancellation, and reject an overlapping request with a retryable conflict. Keep file locks outside network waits. A fallback can advance the binding revision only while its request owns that lease and no output/tool emission makes replay unsafe. This prevents concurrent requests from serving the same job through different models. Control and notice requests do not consume inference leases.

The existing session extractor supplies only a UUID. Supported fixture layouts expose child agent identity, but they do not prove identity transport, prompt isolation, or capability lookup for hidden binding identities in an installed Claude Code build. These remain implementation verification gates. [Session extractor](../src/client-session.ts#L9), [runner fixture](../tests/fixtures/claude-agent-2.1.266.ts#L13), [checkpoint state](../src/execution-checkpoint.ts#L49)

## Decision path

### Activation

1. Read existing preferences. If routing is absent or disabled, execute today's launch, picker, request, and dispatch paths without routing transformations.
2. On enable, validate the routing schema, supported harness anchors, pool references, prompt boundary, fallback references, and resolved effort/capability requirements. Abort activation on an explicit unresolved target.
3. Discover credential mechanisms, explicit billing evidence, account pools, catalog freshness, and model eligibility. Offer balancing controls when the detected mix supports them. Provider names cannot establish subscription status.
4. Build a timestamped cost snapshot from registry metadata and the existing pricing cache. Keep partial, stale, platform-substituted, and subscription-reference costs distinguishable.
5. Create the session router binding. Prefer a configured and eligible DeepSeek/OpenCode floor. If that optional setup choice is absent or unusable, record the reason and resolve Haiku through subscription preference and existing account capacity. If no authorized router target remains, fail launch.

### Specialist launch

6. For each new specialist, require a valid launch identity. Resolve explicit category first, then configured agent-type mapping, then deterministic features for that verified specialist, then `defaultCategory`. Prompt text alone cannot establish that an unidentified request is a specialist.
7. Resolve category effort before any model call. Reject a configured unsupported effort. If support is unknown, surface that state during setup and require provider-default effort or verified metadata. Never invent or silently clamp effort.
8. Resolve an explicit category target first. For deep research, atomically assign A or B by accepted job launch order. Retries and resumes retain their original arm. A fallback does not consume another position.
9. If a category has no explicit target, filter the configured pool by credentials, serving-account catalog, provider/model capabilities, request size, and billing preference. Unknown required capabilities do not count as supported.
10. Rank eligible candidates by the runtime cost estimate. Price-unknown candidates sort last with stable reference ordering. Form same-cost tiers from configured relative tolerance. Missing required components make an estimate unknown.

### Selection and binding

11. For a same-tier tie, consult the session cache using task signature, category, effort, candidate set, policy/config revision, and cost snapshot revision. Separate this semantic cache key from the per-job call budget so equivalent jobs in the session can reuse a decision. Otherwise choose the deterministic stable candidate.
12. On a cache miss, atomically reserve a selector call if enabled, below budget, and economically justified. Send only the bounded signature and candidate references. Timeout, invalid output, unavailable selector, unknown selector cost, or exhausted budget returns the deterministic choice and logs the reason.
13. Persist the binding before launch acknowledgment. Pass its model metadata, effort, and stable specialist prompt to the harness. Show the selected model and reason in the routing notice.

### Dispatch and continuation

14. On every bound request, acquire its revision lease and revalidate authorization, serving capability, and observed availability without reclassifying the task. Resolve the current binding revision and dispatch through the existing route and `dispatchWithPool` where applicable.
15. On an eligible failure before output/tool emission, exhaust permitted same-model account failover first. Then evaluate the configured model fallback chain, persist its new binding revision, log it, and show the fallback notice. Stop on cancellation, unsafe replay, or an exhausted chain.
16. Capture observed usage and estimated cost, retain the binding for continuation/resume, and expire session selector entries with existing execution-state cleanup.

## Existing-preferences config schema

Extend `UserPreferences`, its explicit loader, and its save whitelist in the existing app-home `config.json`. CLI and submenu share those functions and one validator. [Preference type](../src/types.ts#L91), [loader](../src/config.ts#L93), [writer](../src/config.ts#L128)

| Field | Default | Validation and meaning |
|---|---|---|
| `routing.enabled` | `false` when absent | Boolean. Initial setup writes `true` only after validation and patch readiness. |
| `routing.visibleModelId` | `auto` | Nonempty, unique public identity. Reject collision with an existing alias or concrete model identity. |
| `routing.recoveryEnabled` | Absent/false before first enable | The existing preference writer sets this safety flag on enable and retains it on disable. It preserves known-job recovery checks even when a checkpoint is missing, without enabling new routing. |
| `routing.visibleModelLabel` | `Auto` | Nonempty printable label. |
| `routing.policy` | `execution` | Initially only implemented, versioned policy names. Reject unsupported Switchyard algorithm names. |
| `routing.pool` | User-selected discovered references | Unique `ModelRef[]`. It restricts choices within the existing registry, without storing model definitions. |
| `routing.cheapFloor` | Setup suggestion for DeepSeek v4 Flash through OpenCode Go | Optional resolved `ModelRef`. Setup discovers a concrete id and asks the user when the suggestion cannot resolve. |
| `routing.cheapFallback` | Setup suggestion for Haiku 5.5 through native Claude | Resolved `ModelRef` required before enabling. Its compatible API alternative can enter `routerFallbacks`. |
| `routing.routerFallbacks` | Setup-confirmed Haiku serving alternatives | Unique references, no cycles. Only these targets may replace the front router. Keep the delegation-only role on every target. |
| `routing.defaultCategory` | Setup may suggest `orchestration` | When present, it must exist in `categories`. If manual configuration omits it and no unique category matches, selection uses the category-free pool. |
| `routing.categories` | Category suggestions below | Each entry contains optional `target`, optional `effort`, and optional stable specialist instructions. An absent target enables deterministic pool selection. |
| `routing.categories.<key>.requirements` | Optional declared minimum | An object with an optional unique `capabilities` array drawn from `tools`, `images`, `reasoning`, `promptCache`, and `websocket`, and an optional positive safe integer `contextTokens`, constrains new bindings. Ordinary Claude Code specialist launches also require tools. Registry-backed external targets need confirmed positive context and output limits, while Claude Code targets use the existing host metadata lookup. Later request checks can reject unknown additional needs without rebinding the job. |
| `routing.categories.<key>.servingAlternatives` | Setup-confirmed references | Alternate providers serving the same concrete model. Discovery may suggest identical upstream model ids, but setup must confirm equivalence and billing policy. |
| `routing.categories.<key>.fallbacks` | Setup-confirmed ordered references | Authorized worker model replacements, each with its own effort or provider default. Validate capability compatibility before use. |
| `routing.categories.deep_research.alternatingTargets` | User-resolved Luna and Sonnet suggestions | Exactly two unique references with individual effort settings. Mutually exclusive with a single category target. |
| `routing.agentCategories` | Setup-confirmed harness agent types | Agent-type to category mapping. Exact explicit mappings precede heuristics. |
| `routing.subscriptionPreference` | `auto` | `auto`, `subscription-first`, `api-first`, or `balanced`. Unknown billing remains unknown and receives no subscription preference. |
| `routing.selector.enabled` | `true` | Only same-tier ties can invoke it. |
| `routing.selector.target` | The resolved cheap router reference | Must be eligible and configured. No hard-coded provider client. |
| `routing.selector.fallbacks` | Empty | Optional same-role selector references. Calls across this chain share the job's extra-call cap, so the default cap usually leads straight to deterministic selection after failure. |
| `routing.selector.maxExtraCallsPerTask` | `1` | Nonnegative safe integer. Enforce atomically, including timeouts and concurrent requests. |
| `routing.selector.timeoutMs` | `1500` | Positive bounded integer, at most the remaining parent request deadline. |
| `routing.selector.maxOutputTokens` | `128` | Positive bounded integer for a typed selection result. |
| `routing.costTierTolerance` | `0` | Finite nonnegative relative tolerance. Zero means equal estimated cost. |
| `routing.selector.evaluationEvidence` | Empty | Measured token-saving profiles with category, effort, candidate-set/signature versions, sample size, source evaluation id, measured time, expiry, and avoided input/output/cache token components. Validate finite nonnegative counts and reject stale or mismatched profiles. |

The implementer proposes a timeout and output limit, with a separate tolerance for cost tiers. Keep these defaults configurable through the same preferences schema. None expresses a price or availability fact.

Setup suggests matching family references from current discovery and leaves the full price-ordered catalog available. It labels the family suggestion for explicit user selection and version confirmation, and reports an unresolved suggestion when discovery has no match. If discovery cannot confirm a preferred router family match, setup directs the user to choose a discovered Haiku through the existing router-fallback control. A suggestion does not authorize a request or select a model. Once the user saves an explicit reference, an unknown provider/model is a configuration error and cannot silently select another model.

| Category | Suggested model family | Suggested effort |
|---|---|---|
| orchestration | Opus 5.5 | high |
| planning | Sonnet 5.5, with orchestration review | medium |
| coding | Sol | medium |
| qa | Opus 5.5 | medium |
| summarization | An eligible Gemini Flash model through Antigravity | provider default |
| exploration | An eligible Gemini Flash model through Antigravity | provider default |
| research | DeepSeek v4 Flash | high |
| deep_research A | Luna | xhigh |
| deep_research B | Sonnet 5.5 | User chooses during setup |

Gemini 3.8 Flash is a user-suggested example. Resolve the account's available model id through discovery. [Google model list](https://antigravity.google/docs/models)

The planning workflow instructs the orchestration specialist to review the plan before coding. The selector chooses routing references only and cannot approve a plan. Keep the handoff in the stable specialist instructions and inspect review completion during whole-task evaluation. This routing change does not add a workflow scheduler or claim that prompt instructions alone enforce a review dependency.

### Billing metadata and balancing

Extend existing registry provider/account metadata with `billing.kind` (`metered`, `subscription`, `none`, or `unknown`) and evidence (`supplier`, `credential/account`, or `user-confirmed`, with timestamp). An account value overrides the provider default without changing authentication type. Load missing billing metadata as unknown.

Show authentication and billing separately. An OAuth token alone does not prove a paid subscription, and an API key does not prove metered billing. Native Claude account evidence must distinguish subscription credentials from API-key material before the UI claims a subscription.

`auto` detects and offers supported subscription/API choices without treating subscription use as unlimited. `subscription-first` consumes observed eligible subscription capacity before compatible API alternatives. `api-first` reverses that preference. `balanced` enables the existing account balancing within the chosen pool and uses configured serving alternatives for classified cross-pool fallback. It does not compare another provider's quota percentage or monthly credits with this pool's capacity. If capacity is unknown, show that state and retain the configured preference until a classified failure supplies evidence.

The CLI `billing balanced` command enables the existing global account-pool balancing toggle in the same preferences transaction. Other billing choices leave that toggle unchanged. A later global setting or manual configuration edit can override it, and status shows both values.

The routing policy chooses an eligible provider/model pool. `dispatchWithPool` retains account reservation, affinity, quota observation, and failover within that pool. Routing supplies an optional pure account-eligibility constraint before reservation and after registry reload, without replacing ranking or credential handling. Callers without the constraint retain existing behavior. Cross-pool fallback runs only at the routing boundary after the existing dispatcher returns an eligible failure. `servingAlternatives` handles the same concrete model across authorized billing paths, while category fallback chains authorize a different model. Keep Antigravity's credit rejection and no-unapproved-billing checks intact.

## Cost and selector contract

For each candidate, estimate the same workload using expected uncached input, cache reads, cache writes by TTL, and output, including context-price tiers and supplier multipliers when metadata confirms their meaning. Use request limits or bounded observed job usage for the output estimate and record that assumption. Missing rates for a component that the request uses make the estimate incomplete.

Display estimated API-equivalent token cost separately from subscription billing and remaining quota. Keep unknown subscription token prices unknown. Do not divide a monthly fee by guessed usage or equate another platform's rate with a confirmed account charge. Subscription preference and observed capacity are distinct from token-price ranking.

Models.dev's legacy context-tier size omits whether its source condition was strict or inclusive. At an exact threshold, keep the estimate unknown rather than choosing a band. [Models.dev translator](https://github.com/anomalyco/models.dev/blob/dev/packages/core/src/translate.ts#L300)

Build the cheap-to-expensive table from each cost snapshot. Unknown prices sort last and display `price unknown`. An explicitly selected, eligible target can still run with unknown price. Automatic selection chooses a comparable known-price candidate before an unknown one. If all eligible prices are unknown, stable reference order provides a documented deterministic result with an unknown estimate.

Before specialist prompt preparation, the harness may lack the complete input size or a resolved output bound. Keep that launch estimate unknown. An explicit category target remains eligible, while automatic selection puts known base prices before unknown prices and uses stable reference order when request costs remain incomparable. Record `pool_workload_unknown` and skip optional paid selection. Once the complete request arrives, reprice the same binding from its request limit and a labeled input-size estimate without changing its model. Observed usage replaces these assumptions at completion.

The selector receives category, effort, required capabilities, task-size/turn/tool feature buckets, recent failure counts, candidate references, and estimated costs. It does not receive full user text, credentials, source files, or a worker tool set. Validate its typed response against the same-tier candidate set.

The authenticated service computes the opaque task digest before optional selection. The initial 2.1.314 launch hook does not provide complete verified selector features or workload bounds, so it uses deterministic selection and records that skip. A host with complete validated metadata can use the existing adapter or native transport for a qualifying tie. The mandatory cheap front router remains separate from this optional extra call.

A selector call needs a known bounded estimated cost and a matching, unexpired `evaluationEvidence` profile. Reprice that profile's measured avoided token components through the current cost snapshot and require savings greater than the selector cost, including expected cache effects. Equal-price candidates do not establish savings by themselves. The initial implementation uses token-cost evidence and assigns no invented monetary value to latency or quality. Without matching evidence, keep the tie deterministic and log `selector_skipped_no_measured_benefit`. The selector remains enabled for qualifying ties, and an injected measured profile enables the timeout acceptance fixture.

Count the front router's mandatory delegation usage separately from optional selector overhead. Both enter total task cost. The optional selector's one-call budget does not imply that the whole agent uses only one model call.

## Failure and fallback chain

| Trigger | Action |
|---|---|
| Explicit unknown provider/model or invalid category reference | Fail enable/launch with the preference path, reference, and discovery/setup command. A broken explicit reference cannot trigger a model substitution. |
| Existing binding resolves to a changed upstream identity or transport | Fail before credentials or provider dispatch. Restore the original provider configuration or start a new job, preserving the saved binding. |
| Optional OpenCode floor absent at setup | Show detection and configure Haiku through the user's billing choice. Record `floor_not_configured`. |
| Missing credential or rejected credential | Record the failed target. Reuse permitted same-model account handling, then use an authorized fallback target. Never expose credential content. |
| Confirmed quota exhaustion, rate limit, or credit rejection | Use existing failure classification and pool capacity observations, then the configured model chain when the request is safe to replay. Honor the parent deadline and existing retry policy. |
| Subscription capacity exhausted | Prefer the configured compatible API pool when the user enabled that policy. Otherwise use another authorized fallback or fail visibly. |
| Unknown price | Retain an explicit target with an unknown estimate. For automatic selection, place it after comparable known-price models. |
| Selector timeout, invalid result, transport failure, or call cap | Use deterministic policy. Log and show the selector fallback without failing the worker request. |
| Context/tool/image/effort incompatibility before dispatch | Filter automatic candidates. Reject an explicit target with an actionable capability message. Preserve request content. |
| Partial response, emitted tool call, ambiguous execution, or client cancellation | Stop cross-model replay. Preserve existing execution recovery semantics and report the error. |
| Missing harness anchors or unsupported Claude Code layout | Fail routing activation and retain the last working patch. The UI must report inactive routing. |
| Missing binding state on resume | Stop with recovery guidance. Preserve alternation and selector-budget evidence. |
| Persisted inference lease with a confirmed dead owner | Return nonretryable `routing_lease_abandoned` with unknown-outcome recovery guidance. Preserve the lease and decision, and do not replay. A live or uncertain owner remains a retryable conflict. |
| No eligible fallback remains | Return an actionable error. The notice shows the last attempted reference, final cause, and attempted and skipped counts, with a pointer to the secure log for per-reference details. |

Visit each model reference at most once per failed request and share the parent cancellation/deadline across selector and fallbacks. Keep the role fixed. Front-router, optional-selector, and worker requests use separate configured fallback chains, and every replacement retains the tool restrictions of its original role.

A worker fallback keeps task history and tool-result meaning, checks signature provenance, recalculates eligibility and cost, and writes a new binding revision. If the proxy cannot establish portability of the prepared request, fail visibly without replay. The notice identifies both models and explains the cause, including uncertainty about cache reuse. Retain the replacement for that job.

Native-to-native replay accepts completed paired tool history only when each historical tool name remains in the preserved tool definitions. Removed or renamed tools and unsupported provider-bound blocks fail visibly. Tool results must precede text in the immediately following user message.

Recovery without current evidence of the saved native identity fails closed and asks for configuration repair or renewed discovery. It does not infer a missing credential from an absent model row. If a verified identity later loses its credential, the existing not-sent failure and acknowledged fallback rules apply.

## CLI and notices

Add `leverframe switchyard` and a Switchyard submenu to the existing CLI. The interactive flow detects accounts, presents runtime price ordering, resolves setup suggestions, configures categories and billing preference, and enables routing only after validation.

Support `leverframe switchyard enable`, `disable`, `status`, `costs`, `refresh`, `billing <preference>`, and `set <category> --provider <id> --model <id> [--effort <level>]`. Use `set router` for the preferred front target and `set router-fallback` for its required fallback. Deep research uses `set deep_research` with two repeated `--provider`, `--model`, and `--effort` groups. Configuration changes use the existing JSON writer and lock.

The status screen shows enabled state, public id/label, router target, category targets, billing preference, API keys versus OAuth credentials, economic billing evidence, account pools, served models, quota/capacity evidence, and catalog/pricing freshness. It prints no secrets.

The cost table shows provider/model, known input/output/cache rates, estimated workload cost, provenance, subscription status, and unknown components. Subscription suggestions require sourced plan metadata with a fetch time and an explicit price-comparison assumption. If that data is absent, say that Leverframe cannot verify a cheaper subscription. Keep recommendations data-driven.

Status and costs read cached registry and pricing data without refreshing credentials or discovery. They label credential availability as unverified and use a clearly labeled example of one million input and one million output tokens for API-equivalent estimates. An explicit refresh detects configured providers and native Claude models, and the interactive menu keeps its resulting catalog for that session. An unknown price does not block an explicit target.

A discovered target with unavailable credentials can remain configured. If deterministic policy cannot select a category target, the CLI warns that the category cannot currently start, even when the user configured a runtime fallback. Runtime fallback applies after an eligible binding starts. An unresolved reference or unsupported effort fails validation.

Enable refreshes discovery, validates explicit references and efforts, and checks the front router before reconciling the Claude integration. It saves enabled preferences only after verifying the current integration and its routing sites, and fails with a retry instruction if routing preferences change during preparation. New category, billing and enable settings require a new Claude launch and integration reconciliation.

The Claude Code notice names the front router and selected worker. It includes category, effort, policy, and reason so the user can understand each decision without opening a log. Open a session-scoped authenticated decision-event subscription on the existing loopback control surface before routed inference starts. The harness renders each event and acknowledges its exact sequence and decision revision through that same surface. Use bounded acknowledgment waits and deduplicate notices.

The event cursor is a resume hint, not an acknowledgment. On reconnect, the server delivers outstanding notices even when their sequence is at or below the cursor. An authenticated consumer with an active connection may acknowledge a retained receipt again. Once compaction removes that receipt, an old exact acknowledgment returns HTTP 409 and leaves pending notices unchanged. Launch and selector acknowledgment markers survive compaction, so old notices do not reappear as new decisions.

The session checkpoint retains at most 64 unprotected acknowledged notices and 64 KiB of their serialized history. It protects unacknowledged notices, the current pending fallback receipt, and receipts for active binding leases. After acknowledgment and lease release, the checkpoint retires the pending pointer and applies the normal history bounds to its receipt. The binding keeps its chosen model and revision. Protected receipts may exceed those soft bounds. If protected state cannot fit within the existing 512 KiB checkpoint limit, the operation fails visibly rather than discarding evidence. The secure routing log retains detailed transition records.

A provider fallback requires a durable event and its rendered-notice acknowledgment before fallback dispatch starts. This ordering also covers streaming responses without buffering worker output. Stop if the acknowledgment deadline expires or the notice channel fails. Return an actionable error and retain the event for recovery. Launch and request-completion notices use the same channel. The completion notice labels its amount as a binding estimate, not measured billing or a completed-job total.

Disabling routing stops new routed launches in a running proxy and restores the ordinary picker after reconciliation and a new Claude launch. Existing jobs retain their bindings and configured safety fallbacks until completion.

A running proxy reads the current enabled preference while accepting a new binding, after checking for an existing binding. A disable that completes before that read blocks the new binding. A launch accepted before disable can finish, and existing matching bindings continue with their saved target and effort. The ordinary picker returns after reconciliation and a new Claude launch.

## Observability contract

Every routed request logs session/job/binding correlation, request id, role/category, policy and version, decision revision, chosen provider/model, effort, reason code, selection source, pricing snapshot/provenance, estimated cost or `unknown`, and billing/capacity evidence. Existing inference logs remain the destination.

Give each fallback its own event. Record the trigger and both references, then add the account-pool outcome and replay-safety decision alongside the notice revision and estimated cache consequence. For selector activity, record cache hits and new calls with their cost, including timeout/cap outcomes or invalid output and economic skips. Exclude prompts and tool results. Credentials and response text stay out of logs, as do encrypted reasoning and raw task signatures containing text.

Per-attempt usage records carry cumulative provider-reported uncached input and output counts and known cache reads and writes by TTL. Reasoning-token inclusion is provider-dependent when the provider does not report it separately. Compute an API-equivalent amount only when the required measured counts and sourced rates are complete and consistent. Keep missing usage, selector overhead, actual billing, and subscription consumption unknown when evidence is unavailable. Do not sum cumulative stages as separate attempts.

The proxy does not have a trusted job-finish signal and does not claim a completed-job total. An external task evaluator can group correlated router, selector, worker, retry, fallback, and cache records for tasks declared complete by the harness. It should retain unknown components when calculating cache-hit rate, selector overhead, fallback rate, task success, and cost per successful task.

## Evaluation and verification plan

Compare the complete routed agent against a fixed single-model baseline on the same representative tasks, tools, permissions, task limits, and environment. Include router turns, selectors, workers, retries, plan review, fallbacks, and cache writes/reads. Measure cold and warm-cache runs separately and counterbalance run order. Freeze and retain config, catalog, pricing snapshot, and implementation revision for each run. [Switchyard evaluation stance](https://nvidia-nemo.github.io/Switchyard/tuning/)

Use task outcomes, correctness, required review completion, elapsed time, token usage, subscription capacity consumption, API-equivalent cost, paid API cost where known, and cost per successful task. Evaluate completed tasks rather than individual calls. The reviewer chooses the baseline and acceptable quality/cost thresholds before any paid evaluation. No live evaluation runs automatically and no headless Claude runs.

| Required deterministic case | Assertion |
|---|---|
| Routing off | Existing launch/picker/dispatch fixtures retain their prior behavior and outbound model ids. |
| Routing on | Picker contains only the routing entry. A bound specialist request reaches the configured outbound provider/model and effort. Router requests cannot execute coding tools. |
| Missing credential | Classified credential failure uses the documented authorized chain, with decision log and visible notice. Unresolved references still fail hard. |
| Unknown price | Explicit target runs with an unknown estimate. Automatic selection places unknown after known and reports its deterministic fallback. |
| Selector timeout | One bounded call returns deterministic selection, logs the timeout, shows the fallback notice, and never exceeds the per-job cap. |
| Job identity and alternation | Concurrent launches allocate A/B by accepted launch order. Idempotent retry/resume keeps the same binding, effort, arm, and selector budget. |
| Concurrent requests for one binding | A revision lease prevents a second request from using the old model while the first request changes models. Cancellation releases the lease without replaying ambiguous work. |
| Session selector cache | Separate jobs with the same signature/category reuse a semantic decision. The per-job budget counts only new provider calls, including selector fallback attempts. |
| Prompt/cache preservation | Specialist receives its task and required instructions/state. Bound follow-up requests preserve prompt prefix, cache controls, provider session identity, and tool-result meaning. |
| Failure after output | No cross-model retry after content/tool emission or ambiguous execution. |
| Billing mix | API-key subscription, OAuth subscription evidence, unknown billing, and native Claude credentials remain distinct. Existing pool dispatch handles accounts. |
| Fallback notice | Streaming fallback dispatch waits for the rendered-notice acknowledgment. Disconnect or acknowledgment timeout returns an error before a replacement provider call. |

Deterministic fixtures exercise these contracts with isolated homes, injected credentials, loopback transports, and supported-artifact source. Isolated Node 22 typecheck, lint, build, and package verification passed. The full suite passed 449 files and 3,818 tests, with five files and 11 tests skipped. Package verification found 13 files and 1,375,922 unpacked bytes.

Static checks of the retained supported artifact passed for active and recovery transformations without executing the vendor application. These checks do not establish installed interactive behavior or live provider availability.

## Graph evidence and implementation gates

The following table is historical. The initial GitNexus index matched the inspected commit, but reported `scope-extraction-unverified`. MCP keyword queries failed because FTS was unavailable. Named context queries found callers, while MCP impact returned partial UNKNOWN results. Initial CLI fallback returned some plausible narrow results and some broad results with incomplete target metadata.

| Candidate extension | Confirmed callers/processes | Reported risk and required action |
|---|---|---|
| `decideHttpProxyRoute` | `handleMitmRequest`, MITM process memberships | CLI LOW, two affected symbols. Re-run for the exact final edit. |
| `prepareProxyMessage` | `handleProxyMessages`, proxy request/message processes | CLI LOW, three affected symbols. Re-run for the exact final edit. |
| `buildDesiredPatchConfig` | patch reconciliation/state checks, diagnostics, legacy recovery | CLI CRITICAL, 233 affected symbols and 53 process groups. Validate exact target resolution before editing. |
| `applyConfiguredModelPicker` | `applyLeverframePatches` | CLI CRITICAL, 288 affected symbols and 33 process groups, incomplete target metadata. Resolve before editing. |
| `applyModelPickerOptions` | `applyConfiguredModelPicker` | CLI CRITICAL, 260 affected symbols and 31 process groups, incomplete target metadata. Resolve before editing. |
| `loadHttpProxyRoutes` | configured proxy startup, launch dry run, model listing | CLI CRITICAL, 233 affected symbols and 53 process groups. Validate target resolution before editing. |
| `loadPreferences` | CLI, patcher, server, pool dispatcher, route loading, context policy | UNKNOWN/partial, ambiguous CLI lookup. Resolve exact symbol and confirm text references. |
| `savePreferences` | config helpers, alias/favorite CLI, account prompts, launch recording | CLI CRITICAL, 260 affected symbols and 31 process groups, incomplete target metadata. Resolve before editing. |
| `RegistryProvider` | registry parser and provider/account consumers | MCP UNKNOWN/partial. Confirm exact impact before adding billing metadata. |
| `dispatchWithPool` | native/SDK pool adapters and OpenAI pool handlers, pooled execution processes | Initial MCP UNKNOWN/partial conflicts with CLI CRITICAL/truncated. Reuse the existing balancer with the optional eligibility constraint described above. |
| `lookupModelCost` | pricing enrichment callers | MCP UNKNOWN/partial. Reuse pricing machinery and resolve impact before any necessary provenance edit. |

A subsequent index-only force rebuild restored usable exact-file CLI checks for three sampled symbols at that checkpoint. `loadPreferences` reported CRITICAL with 70 affected symbols, `applyModelPickerOptions` HIGH with three, and `decideHttpProxyRoute` LOW with two. These are historical results, not a final graph assessment.

Implementation used per-symbol impact checks and source checks where graph results could not resolve callers. The final graph rebuild reported 10,914 nodes, 30,185 edges, 965 clusters, and 300 flows. Complete local CLI change analysis returned 2,521 changed symbols across 220 files and 160 affected processes, without partial or truncated results. It rated shared configuration, proxy, pool, and patch paths CRITICAL. The review inspected 30 grouped entry-process families. Any future edit still requires its own impact check, and an authorized commit requires nonpartial, nontruncated `detect_changes`.

## Decision log and next actions

| Decision or action | Owner | Priority | State |
|---|---|---|---|
| One visible Claude Code entry, configurable Leverframe catalog and notice | User | P0 | Accepted |
| Cheap front router delegates, orchestration is specialist work | User | P0 | Accepted |
| Explicit category first, inference only for identified specialists | User | P0 | Accepted |
| Bind at launch, retain model/effort, permit logged availability fallback | User | P0 | Accepted |
| Alternate separate deep-research jobs, keep each job's arm | User | P0 | Accepted |
| Category targets first, cheapest eligible configured model otherwise | User | P0 | Accepted |
| Explicit economic billing metadata, preserve unknown values | User | P0 | Accepted |
| Same-tier selector enabled with call cap and measured break-even gate | User/reviewer | P0 | Accepted and implemented |
| Compact specialist task with required instructions and state | User | P0 | Accepted |
| Hidden binding identities, persisted allocation, loopback notices | Reviewer | P0 | Accepted and implemented |
| Verify prompt boundaries, harness effort precedence, hidden-id capability lookup, and interactive fallback notice | Implementer/user | P0 | Deterministic fixtures cover the contracts, installed interactive verification remains open |
| Complete final regression, package checks, and graph change analysis | Implementer | P0 | Complete |
| Choose evaluation baseline and quality/cost thresholds | Reviewer | P1 | Required before paid evaluation |
| Accept this design for implementation | User | P0 | Accepted |

## What remains unverified

No live provider inference, credential refresh, headless Claude invocation, or interactive Claude Code capture ran. Deterministic fixtures and static supported-artifact checks do not prove the installed harness's final child prompt, hidden binding identity support, effort precedence, or live fallback notice delivery. Account-specific availability, charged prices, subscription exhaustion, whole-task quality, cost, and savings remain unverified.

## Provider capabilities outside this change

| Capability and source | Current boundary | Cost estimate |
|---|---|---|
| OpenAI extended prompt-cache retention and per-breakpoint lifetime controls. [Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) | Current translation sets supported implicit caching to a fixed TTL and does not expose all retention choices. [Translation](../src/sdk-request-translation.ts#L318) | Additional retained-cache write cost minus avoided later prefix writes/uncached input, calculated from snapshot rates and observed reuse. Unknown without those rates. |
| OpenAI prompt-cache prewarming. [Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) | No prewarm request path appears in routing/translation. It would add a provider call. | Prewarm input/cache-write charge minus later avoided prefix processing. Require measured reuse before enabling. |
| Anthropic per-message effort preserving the earlier prefix on supported models. [Caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Current request translation reads top-level effort. No dedicated per-message effort mapping appears in that path. [Effort reader](../src/sdk-request-translation.ts#L62) | Avoided prefix rewrite cost on effort changes, computed from affected tokens and cache rates. This design keeps effort stable instead. |
| Gemini thinking levels offered by Antigravity. [Google model docs](https://antigravity.google/docs/models) | Current discovery derives effort from suffixed ids and does not establish effort support for a tiered model id. [Catalog parser](../src/antigravity/models.ts#L13) | Change in reasoning/output usage times known rates or observed subscription consumption. Unknown until account metadata and usage confirm it. |

These examples cover inspected adapter paths and provider documentation. They do not exhaust every provider capability. This change leaves their implementation outside scope.
