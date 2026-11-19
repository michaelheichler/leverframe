# Codex subscription usage investigation

This file records the retired Codex device route. Current ChatGPT plan connections use `openai-chatgpt-plan` and the public Responses API. See [setup instructions](../README.md#get-started).

## GPT-6.2 model access on November 19, 2026

Claude Code displayed an HTTP 400 for `gpt-6.2-astra` that reported a model restriction for the ChatGPT account. The user also reported trouble with `gpt-6.2-sol`. The investigation traced the source and checked public documentation without replaying either request against OpenAI.

- The old device sign-in used the Codex device flow. Model discovery sent the installed Claude Code version as `client_version` to the Codex catalog and could fall back to the general ChatGPT catalog. A listing alone could not verify inference access.
- The old inference route sent OAuth requests to the Codex backend. For Responses Lite, Leverframe used a model-specific catalog minimum when it exceeded the `0.159.2` default. OpenAI requires native Codex CLI `0.166.0` or later for the two models. The installed CLI reported `0.170.0`, but Leverframe sent its own requests. The older default could have contributed. The investigation did not capture the failing request headers or the server admission decision. [Codex model availability](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)
- OpenAI documents a separate OAuth flow for open-source apps using ChatGPT plans. It grants `chatgpt.tokens.use.direct` and uses the selected account token for `GET https://api.openai.com/v1/models` and `POST https://api.openai.com/v1/responses`. The inference example uses `gpt-6.2-sol`. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

The available records do not confirm the scope or current status of Leverframe's approval. To verify access, use the app registration and grant that OpenAI authorizes, check both IDs in the same account catalog, and send one minimal streamed request per available model. Capture the HTTP status, structured error code if present, request ID, and terminal stream event. A native Codex check with the same workspace can confirm native model access. [OpenAI error guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

Leverframe removed the Codex device route, its model discovery, and its transport. The `openai-chatgpt-plan` provider uses the selected account catalog and public Responses streaming. Live GPT-6.2 access depends on the account and grant.

## Subscription usage

The user reports much faster ChatGPT allowance consumption when Codex models run through Claude Code and Leverframe than in native Codex. Local records establish a large cache efficiency difference. They do not yet establish its cause or a subscription charging multiplier.

## Local evidence

The following observations cover November 1, 2026 UTC. They compare different workloads and request populations. They are diagnostic evidence, not a controlled benchmark.

| Recorded population | Input including cached reads | Cached reads | Uncached input | Cache read share |
| --- | ---: | ---: | ---: | ---: |
| Native Codex sol sessions, including the parent session | 243,340,124 | 240,747,264 | 2,592,860 | 98.93% |
| All matching native Codex sessions, including subagents | 941,658,434 | 932,438,912 | 9,219,522 | 99.02% |
| Leverframe OAuth sol completions that day | 182,997,107 | 94,449,280 | 88,547,827 | 51.61% |

The native aggregate covers 38 session files whose working directories match this repository or the feature worktree, including two sol, nineteen terra, and seventeen luna sessions. The sol row is a subset of the all-model row. Per-file accounting starts with the first event's last usage and adds subsequent cumulative counter differences, avoiding inherited earlier usage and thirteen duplicate events. No counter resets occurred. Directory dates and resumed sessions still limit time attribution.

Leverframe recorded 1,345 final usage events for distinct sol request IDs across its logged traffic. The native parent selected `gpt-6.1-sol` with medium effort. Leverframe recorded 605 high effort and 767 medium effort sol requests, including requests without final usage. The model mix and workloads differ, so these populations cannot support a matched cost ratio.

Current local configuration maps `sol` to `gpt-6.1-sol` and selects WebSockets with Responses Lite. This matches the native model name now. It does not prove the settings that older running processes loaded or the effective model of every historical request.

Joining request IDs with recorded session metadata groups those 1,345 completions into three known Claude sessions. Of those completions, 414 report zero cache reads. Their first recorded requests total only 93,917 uncached input tokens, leaving 88,453,910 reported uncached input tokens on later requests. The cache gap therefore extends beyond the first recorded request of each session. These counters cannot reveal whether changing prefixes, routing, or another cause prevented reuse.

Native input counters include cached input. Leverframe translates OpenAI SDK usage into Anthropic wire semantics and records uncached input separately from cache reads. Adding native input and native cached input would double count. Adding Leverframe uncached input and cache reads reconstructs total input for these records. The observed records reported no cache creation tokens. The deployed streaming translator can retain an initial input estimate when final usage lacks input counts, so the Leverframe aggregate cannot guarantee provider actuals for every row.

The records contain 20 upstream error events for OAuth sol that day, including three HTTP 500 and seventeen HTTP 502 events. Some requests used retry attempt two. This count does not by itself explain the cache difference, and existing logs cannot establish how the provider charges failed attempts.

## Confirmed protocol difference

Before this fix, Leverframe supplied a body `prompt_cache_key` derived from a validated Claude session ID or a fallback prompt fingerprint. Its OAuth provider setup omitted the Responses `session-id` header. The [official Codex client source](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) states that ChatGPT derives cache affinity from that header. Native Codex manages the body cache key and session header separately.

This omission gives a concrete interoperability defect to test with a fake upstream. It remains a hypothesis for the measured cache difference. A header correction alone cannot guarantee cache hits when instructions, tools, history, account selection, or routing change.

## Other contributors under review

Claude Code can issue separate calls for tools, subagents, compaction, and background tasks. Native Codex also supports subagents. Count actual requests before assigning an orchestration overhead.

Leverframe can submit full history or fall back from WebSocket continuation. It also bounds retries. Full history on the wire does not prove the provider recomputes the whole prefix. The provider may cache it. Continuation fallback can create another submission without proving that the failed submission consumed allowance.

Available logs contain no WebSocket diagnostic files or exact `ws_head_decision`, `ws_transport_retry`, or `ws_response_error` JSON events. Historical continuation and transport replay counts therefore remain unknown.

The OAuth path does not forward Claude's output token limit and Responses Lite disables parallel tool calls. These choices can affect generated output or tool loop count. Runtime evidence must establish their contribution before changing behavior.

[OpenAI's usage guidance](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) identifies model, context, reasoning, speed, tools, and task complexity as usage factors. [Fast mode documentation](https://learn.chatgpt.com/docs/agent-configuration/speed) currently specifies a 2.5 times included allowance rate for supported models. No evidence currently establishes that Leverframe selects Fast mode. The translator does not explicitly set a service tier, and local native turn metadata does not record a tier.

## Verification boundaries

This investigation reads local metadata and official documentation without making model calls, refreshing credentials, or submitting prompts to Claude or OpenAI. Conversation bodies stay private. Published findings contain aggregate counts and source references only.

At the investigation checkpoint, the CLI links resolved to the original checkout's `dist/cli.js`, version 0.4.11, which differed from committed source. Some processes predated that build. Their paths cannot establish which bytes they loaded, and the feature worktree did not drive them.

The feature branch now sets the Responses session header per request from the same bounded hashed key as the body cache key, exclusively for OpenAI OAuth. It preserves the existing OpenCode header behavior and keeps session state out of cached model configuration. When no validated session UUID exists, the existing fallback hashes system instructions and tools. Identical prefixes can share that fallback, and prefix changes can rotate it. It is not a guarantee of distinct sessions.

Nine initial deterministic tests cover translation, provider boundaries, proxy and server routes, and WebSocket handshake isolation. The proxy test uses the real SDK with a fake HTTP upstream. These checks pass without provider calls.

The November 2 release closes independent source QA and the broader offline regression run with 2,702 passing tests and eight skips. The merged 0.5.0 build passes package installation checks, and both discovered global Node installations report 0.5.0. Both Claude Messages and public OpenAI chat routes now retain request-scoped OAuth cache affinity. Existing processes still need a new interactive session to load the installed build.

A later user initiated interactive comparison can establish cache and allowance effects on matched tasks. Until then, report the protocol omission and observed cache gap separately from provider quota weighting.
