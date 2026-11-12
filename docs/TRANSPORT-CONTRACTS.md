# Claude launch and subscription transport contracts

## Context and tool search

`src/env.ts` clears inherited `CLAUDE_CODE_MAX_CONTEXT_TOKENS` before applying a confirmed positive, finite context limit. Catalog launches omit this override so a later `/model` switch can use its own selected limit. Direct endpoint launches pass their selected window. Missing metadata stays unknown.

The `[1m]` suffix is a Claude Code compatibility marker. `claudeCodeClientModelId` adds it only when a confirmed selected window reaches the protocol threshold. The marker does not supply model metadata and must not replace the account's reported context value.

A custom `ANTHROPIC_BASE_URL` can disable native MCP tool search and cause Claude Code to load all tools on every turn. `applyClaudeCodeThirdPartyCompat` enables tool search and retains the full system prompt. Request translation preserves tool-search tools, includes deferred tools only when a reference requires them, and retains ordinary tools. `src/tool-search.ts` owns that selection policy.

## OAuth refresh concurrency

`src/env.ts` shares an in-flight refresh for the same account and rejected access token. It also acquires the account credential mutation file lock, rereads the keyring, and checks that the stored credential has not changed before writing a replacement. This protects refresh-token rotation across concurrent requests and processes.

If credentials change concurrently, the refresh operation retries within its limit and refuses to return a token the provider already rejected. Each completed or failed refresh removes the in-flight entry, allowing a later request to try again. The account file lock lives in `src/registry/lock.ts`.

## Transient authentication outages

An HTTP 401 that wraps an upstream 5xx, rate limit, or too-many-concurrent-requests error does not prove that a credential is invalid. OpenAI OAuth transport retries only the client's existing request, at most twice, with exponential backoff and jitter. It preserves the serialized body, headers, neutral instructions, and prompt cache key. A genuine credential rejection returns immediately without a retry.

If the transient failure remains, the account receives a finite 30-second block rather than a permanent authentication failure. Expiry only makes a later real client request eligible. Leverframe sends no synthetic recovery, test, probe, or keep-warm inference requests.

`tests/account-pool-transient-auth.test.ts` and `tests/account-pool-transient-auth-retry.test.ts` cover temporary blocks and exact replay. They also verify that genuine credential rejection stops immediately.

## Subscription WebSocket upgrade failures

The subscription Responses transport treats an HTTP 403 during WebSocket upgrade as a retryable rate limit. The OpenAI edge can return that status before the request reaches the application. The general HTTP classifier would instead report a terminal permission failure and prevent retry.

`src/oauth/responses-websocket.ts` maps this upgrade failure to internal status 429 and the `rate_limit` category. This exception belongs to the subscription upgrade path, not every provider HTTP 403. The backoff helper bounds valid `Retry-After` values and supplies a delay when the header is absent or invalid. The pending-upgrade state prevents `error` and `close` events from processing the same failure twice.

Regression fixtures include upgrade responses with explanatory bodies and responses without them (`tests/responses-websocket.test.ts` and `tests/responses-websocket-upgrade.test.ts`).

## Connection capacity notices

The adapter allows 64 active sockets and the proxy accepts at most 256 clients. A fixed, payload-free stderr notice reports requests queued behind the adapter limit. Another reports sockets rejected by the proxy's `drop` event. Each server or agent emits its notice at most once per 30 seconds, without retaining request or client data.

`tests/http-proxy-capacity-notices.test.ts` covers burst suppression and private-value exclusion.

## Provider completion validation

The adapters reject empty completions even when the provider reports output-token usage. Failed or missing terminal events produce errors. A streaming reasoning signature preserves round-trip state without summary text, and meaningful partial output retains `max_tokens` when the provider stops at its output limit.

Empty upstream completions produce HTTP 502. The proxy's existing retry cap applies only before the adapter emits response content or a tool call. Confirmed context overflow produces non-retryable HTTP 400. Context comparisons add cache reads and writes to uncached input. Missing or unconfirmed route limits remain unknown.

Completion diagnostics record normalized and raw finish reasons separately, along with total input, uncached input, cached input, and output tokens. WebSocket terminal diagnostics also record the upstream event, response status, incomplete reason, output-item count, and reasoning-token count. Neither response text nor encrypted reasoning enters these records. Raw response identifiers also stay out.

## Conversation heads and connection generations

A session partition can have several valid conversation heads after a rewind, branch, title request, or stop hook. A single latest-head slot would discard connections that a later request can still continue. The pool therefore keeps a set of entries per partition, and the transport proves a conversation-prefix match before continuing a head.

New heads enter the nursery generation. A real continuation promotes a head to the established generation. Separate TTL and LRU limits prevent one-shot traffic from evicting reusable established connections. Established entries also do not consume nursery capacity. `src/oauth/responses-websocket-connection-pool.ts` owns generation-specific eviction.

The internal pool reset clears bookkeeping only. Tests must use the public transport reset helper, which first closes active contexts and sockets. Calling the bookkeeping reset on live connections would lose the references needed for cleanup.

`tests/responses-websocket-continued.test.ts` covers branches, promotion, expiry, and the independent generation limits.
