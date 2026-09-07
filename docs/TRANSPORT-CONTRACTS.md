# Claude launch and subscription transport contracts

## Context and tool search

`src/env.ts` clears inherited `CLAUDE_CODE_MAX_CONTEXT_TOKENS` before applying a confirmed positive, finite context limit. Catalog launches omit this override so a later `/model` switch can use its own selected limit. Direct endpoint launches pass their selected window. Missing metadata stays unknown.

The `[1m]` suffix is a Claude Code compatibility marker. `claudeCodeClientModelId` adds it only when a confirmed selected window reaches the protocol threshold. The marker does not supply model metadata and must not replace the account's reported context value.

A custom `ANTHROPIC_BASE_URL` can disable native MCP tool search and cause Claude Code to load all tools on every turn. `applyClaudeCodeThirdPartyCompat` enables tool search and retains the full system prompt. Request translation preserves tool-search tools, includes deferred tools only when a reference requires them, and retains ordinary tools. `src/tool-search.ts` owns that selection policy.

## OAuth refresh concurrency

`src/env.ts` shares an in-flight refresh for the same account and rejected access token. It also acquires the account credential mutation file lock, rereads the keyring, and checks that the stored credential has not changed before writing a replacement. This protects refresh-token rotation across concurrent requests and processes.

A concurrent credential change causes a bounded retry. A rejected token must not become the result of a later refresh. Completion and failure both remove the in-flight entry so future requests can retry. `src/registry/lock.ts` owns the account file lock.

## Subscription WebSocket upgrade failures

The subscription Responses transport treats an HTTP 403 during WebSocket upgrade as a retryable rate limit. The OpenAI edge can return that status before the request reaches the application. Applying the general HTTP classifier would instead report a terminal permission failure and prevent retry.

`src/oauth/responses-websocket.ts` maps this upgrade failure to internal status 429 and the `rate_limit` category. This exception belongs to the subscription upgrade path, not every provider HTTP 403. The backoff helper bounds valid `Retry-After` values and supplies a delay when the header is absent or invalid. The pending-upgrade state prevents `error` and `close` events from processing the same failure twice.

`tests/responses-websocket.test.ts` and `tests/responses-websocket-upgrade.test.ts` cover upgrade responses with and without explanatory bodies.

## Conversation heads and connection generations

A session partition can have several valid conversation heads after a rewind, branch, title request, or stop hook. A single latest-head slot would discard connections that a later request can still continue. The pool therefore keeps a set of entries per partition, and the transport proves a conversation-prefix match before continuing a head.

New heads enter the nursery generation. A real continuation promotes a head to the established generation. Separate TTL and LRU limits prevent one-shot traffic from evicting reusable established connections. Established entries also do not consume nursery capacity. `src/oauth/responses-websocket-connection-pool.ts` owns generation-specific eviction.

The internal pool reset clears bookkeeping only. Tests must use the public transport reset helper, which first closes active contexts and sockets. Calling the bookkeeping reset on live connections would lose the references needed for cleanup.

`tests/responses-websocket-continued.test.ts` covers branches, promotion, expiry, and the independent generation limits.
