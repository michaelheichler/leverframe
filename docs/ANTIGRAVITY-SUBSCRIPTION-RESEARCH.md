# Antigravity subscription transport research

Research date 2026-10-31. This note records source inspection, without live account verification or an implementation decision.

## Fixed requirements

- Keep the patched Claude Code binary, model picker, information harness, tools, and subagent executor.
- Let Leverframe own browser login and direct inference without downloading a Google runtime or requiring a Google app installation.
- Consume existing Antigravity subscription allowance, with no API key setup, separate inference billing, or paid fallback.
- Normalize identity instructions that the harness emits before they reach the model.

## Evidence and limits

| Source | Inspected revision | Evidence |
|---|---|---|
| NoeFabris/opencode-antigravity-auth | `05e600ad6c780a429e7c23d2b0202d2e81e8ff7f`, committed 2026-10-27 | OAuth, refresh, account discovery, quota parsing, and request translation |
| pleaseai/shunt | `a33fc9095e54ad70b455426761dbb85c574977e9`, committed 2026-10-30 | Direct HTTP transport, account catalog, grouped quota RPC, and request envelope |

Both implementations contain direct HTTP transports. Their code provides implementation precedent, not guaranteed account access. Shunt records a maintainer probe that returned HTTP 200 after changing both host and envelope, so the probe does not isolate which fields the server requires. Leverframe has not repeated that probe. [Envelope source](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/model/antigravity_request.rs#L38).

Google excludes third-party use of personal Antigravity login in its published terms, which limits support and account continuity independently of technical feasibility. [Google terms, section 6](https://antigravity.google/terms).

## Authentication and account discovery

Noe uses authorization-code OAuth with S256 PKCE, offline access, a browser, and a loopback callback. Exchange and refresh reference bundled Antigravity OAuth client ID and client-secret constants. This note omits those values. Reusing that registration does not establish that a new Leverframe OAuth registration gets the same entitlement. [OAuth source](https://github.com/NoeFabris/opencode-antigravity-auth/blob/05e600ad6c780a429e7c23d2b0202d2e81e8ff7f/src/antigravity/oauth.ts#L91), [refresh source](https://github.com/NoeFabris/opencode-antigravity-auth/blob/05e600ad6c780a429e7c23d2b0202d2e81e8ff7f/src/plugin/token.ts#L139).

Both defaults name `daily-cloudcode-pa.googleapis.com`, without `.sandbox`. Older search snippets naming sandbox hosts do not match these revisions. [Noe constants](https://github.com/NoeFabris/opencode-antigravity-auth/blob/05e600ad6c780a429e7c23d2b0202d2e81e8ff7f/src/constants.ts#L32), [shunt defaults](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/auth/antigravity/auth.rs#L83).

Shunt calls `loadCodeAssist`, extracts the managed project, and calls `onboardUser` if discovery returns no project. Onboarding can return an operation that the client must poll. The managed project identifies the subscription service context, which does not prove the user must create a separately billed Cloud project. [Discovery source](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/auth/antigravity/auth.rs#L881).

## Catalog and quota

`fetchAvailableModels` authenticates with the account bearer. Noe parses model `quotaInfo.remainingFraction` and `resetTime`, while shunt uses the catalog to resolve account-specific Gemini suffixes and tiered IDs. A static global model list cannot establish account availability. [Noe quota source](https://github.com/NoeFabris/opencode-antigravity-auth/blob/05e600ad6c780a429e7c23d2b0202d2e81e8ff7f/src/plugin/quota.ts#L224), [shunt catalog](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/auth/antigravity/catalog.rs#L286).

Shunt also calls `retrieveUserQuotaSummary` with bearer and project. Its parser exposes shared model-family quota windows. Those snapshots do not reserve future capacity. [Quota-summary source](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/auth/antigravity/usage.rs#L49).

## Inference and the retained tool loop

Shunt addresses `generateContent` and `streamGenerateContent?alt=sse`. Its envelope contains `project`, `model`, the inner Gemini request, agent metadata, and a session ID. That transport does not launch a Google subprocess. [Adapter source](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/adapters/gemini/mod.rs#L560), [envelope source](https://github.com/pleaseai/shunt/blob/a33fc9095e54ad70b455426761dbb85c574977e9/src/model/antigravity_request.rs#L38).

Noe transforms native function calls, function responses, and thinking signatures. Leverframe must preserve those fields across subsequent turns. Copying the entire plugin would import unrelated behavior and maintenance burden. [Translation source](https://github.com/NoeFabris/opencode-antigravity-auth/blob/05e600ad6c780a429e7c23d2b0202d2e81e8ff7f/src/plugin/request.ts#L376).

The architectural inference is a native provider transport behind the Leverframe proxy. Claude Code would retain tool execution and send results on subsequent turns. Source inspection does not prove end-to-end compatibility, which needs request and stream fixtures.

## Credit opt-in evidence and remaining verification

Google documents an AI Credit Overages setting with `Never` and `Always` modes. Under `Always`, the backend can consume purchased or promotional credits after baseline quota runs out. The user has not supplied the current setting. [Google overages](https://antigravity.google/docs/plans#overages).

Further investigation found a client credit opt-in. Google's CLI reference lists `useG1Credits` with default `false`, and its credits guide says off restricts fallback billing. This strengthens the subscription-only direction without establishing direct HTTP enforcement. [CLI reference](https://antigravity.google/docs/cli/reference/), [credits guide](https://antigravity.google/docs/cli/credits).

At official Gemini CLI commit `6814e00d6b148c3a1d57244d5d7040f7c541009d`, `server.ts` chooses `['GOOGLE_ONE_AI']` when credits qualify, otherwise `undefined`. The converter maps that argument to `enabled_credit_types`, and JSON serialization omits the undefined field. This is first-party Code Assist behavior, not proof of Antigravity backend policy. [Selection](https://github.com/google-gemini/gemini-cli/blob/6814e00d6b148c3a1d57244d5d7040f7c541009d/packages/core/src/code_assist/server.ts#L113), [conversion](https://github.com/google-gemini/gemini-cli/blob/6814e00d6b148c3a1d57244d5d7040f7c541009d/packages/core/src/code_assist/converter.ts#L129).

CLIProxyAPI commit `dbb706215a3afd2f0ea3c96482d4233856466caa` injects the camelCase `enabledCreditTypes` field through an explicit credit retry path. Leverframe should omit both spellings and provide no such retry. An empty array has no verified negative-credit semantics. [Credit injection and gate](https://github.com/router-for-me/CLIProxyAPI/blob/dbb706215a3afd2f0ea3c96482d4233856466caa/internal/runtime/executor/antigravity_executor_credits.go#L199).

Google's Code Assist source reads `paidTier.availableCredits` through a `loadCodeAssist` health check and observes response `consumedCredits` and `remainingCredits`. A balance read does not reveal the overage policy, and detecting consumed credits happens after spending. No verified account-policy RPC or explicit negative-credit flag emerged from the inspected sources. [Balance refresh](https://github.com/google-gemini/gemini-cli/blob/6814e00d6b148c3a1d57244d5d7040f7c541009d/packages/core/src/code_assist/server.ts#L297), [credit observations](https://github.com/google-gemini/gemini-cli/blob/6814e00d6b148c3a1d57244d5d7040f7c541009d/packages/core/src/code_assist/server.ts#L163).

A quota precheck cannot guarantee zero credit consumption, because another session can consume the allowance before inference completes. Preventing fallback to AI Studio, Vertex AI, or another paid provider does not establish that the subscription backend will never consume credits.

The remaining evidence is a direct Antigravity request at exhausted baseline allowance that omits all credit opt-ins, receives a quota rejection, and leaves credit balance unchanged. Record the account overage setting with that evidence. Do not enable or spend credits to collect it. A successful request below quota does not prove this condition.

## Leverframe boundaries and dependency check

GitNexus binds `leverframe` to HEAD `75bbbd631b1d93c62c2cb5b076e046c4f744d737`, indexed October 30. Scope extraction remains unverified, FTS queries fail, and source impacts return partial UNKNOWN results. Source inspection confirms callers, so implementation must refresh the graph before interpreting risk.

`src/server/route-helpers.ts` omits `providerData` when creating a model. Generic runtime caches track token strings without project metadata. Use an Antigravity resolver to read a coherent token/account/project snapshot per request, and reject the generic environment credential override on this subscription path. Keep changes scoped to this provider.

`src/proxy-shared.ts` keeps tool signatures over 256 bytes in an in-memory registry. A restarted proxy loses them. The integration needs persistent account/session-scoped signature references or an explicit resume failure, rather than signature fabrication.

The npm registry reports `@ai-sdk/google@4.0.12` depends on `@ai-sdk/provider@4.0.3` and `@ai-sdk/provider-utils@5.0.7`, matching Leverframe. Its published declarations export `createGoogle` and a custom fetch hook. Add it as a normal Leverframe dependency during implementation, with no lazy installation or Google agent runtime. This metadata check did not install a package. [Published package metadata](https://registry.npmjs.org/@ai-sdk%2fgoogle/4.0.12), [declarations](https://unpkg.com/@ai-sdk/google@4.0.12/dist/index.d.ts).

## Evidence needed before implementation claims

| Priority | Owner | Evidence | Acceptance condition |
|---|---|---|---|
| P0 | Integration owner | First login without a Google runtime | Entitlement, managed project, and catalog resolve without manual Cloud setup |
| P0 | Integration owner | Backend credit policy | Requests cannot consume purchased or promotional credits |
| P0 | Integration owner | Text and tool round trip | Claude Code retains execution, arguments and results survive, and streams terminate |
| P0 | Integration owner | Captured harness instructions | Normalization covers main agents and subagents before dispatch |
| P1 | Integration owner | Model metadata | Picker matches account catalog and identifies unconfirmed context limits |
| P1 | Integration owner | Revocation and quota fixtures | Requests stop with account-specific errors and never enter paid fallback |

Research read public source files without running Google login, account endpoints, model calls, or Claude processes.
