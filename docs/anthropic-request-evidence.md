# Anthropic request evidence

Verified on 2026-11-01 against official documentation. These findings guide implementation and acceptance tests. They do not establish a cache hit or measured savings for any particular request.

| Source | Supported behavior | Implementation boundary |
| --- | --- | --- |
| [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | Top-level automatic caching and explicit block breakpoints both exist. Cache reuse depends on an unchanged prefix. | Preserve client cache directives and ordered system, tools and messages. Never pad a prompt to reach a minimum. |
| [Cache usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance) | Total input combines uncached input, cache reads and cache creation. Responses can split creation by TTL. | Keep raw component counts and missing values. An estimate cannot establish billed cost. |
| [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) | Clearing history can invalidate the cached prefix. Client context management controls history behavior. | Preserve the original when local rewriting could conflict with client policy or opaque provider state. |
| [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting) | Counting estimates input without cache lookup. Cache directives do not make a counting request create a cache. | Forward count requests without compaction. Do not infer a cache hit from a token estimate. |
| [Gateway caching](https://code.claude.com/docs/en/prompt-caching) | Claude Code sends block-form content with cache directives through gateways. | Carry the client representation through the native route. |
| [Rate limits](https://platform.claude.com/docs/en/api/rate-limits) | Quota scopes and reset evidence differ from inference token usage. | Account pools own capacity observations and safe retry decisions. Compaction must run once before account attempts. |
| [API errors](https://platform.claude.com/docs/en/api/errors) | Authentication, permission and billing errors have distinct meanings. The current page describes spend-limit responses beyond rate-limit status codes. | Preserve the request API version and original error. Confirm a quota rejection before considering replay, rather than treating every client error as exhaustion. |
| [API versions](https://platform.claude.com/docs/en/api/versioning) | The version header is required and the SDK supplies it. The 2026-10-21 version changes request validation, while error conditions may change within a version. | Forward an explicit native caller version. Retain 2023-06-01 when absent. SDK translation owns its wire version. |

The error documentation checked on 2026-11-01 describes 402 `billing_error`, generic 400 `invalid_request_error` including spend limits, and 429 `rate_limit_error`. It does not identify an unambiguous spend-limit error body for 400 or establish that every billing error is an exhausted credit balance. The pool classifies only the documented 402 type as a billing block, and the response identifies the need for billing or payment action. The pool does not infer balances from usage.

The Messages API version remains the caller's existing version. The optimization must not silently select another API version or beta feature. Model pricing and minimum cache sizes vary, so neither belongs in a universal constant.

Acceptance records estimates separately from actual upstream usage. It includes policy latency and upstream latency. Any summary benchmark includes summary input and output across a session that reuses the summary, with local tokens separate from paid usage. Fixture results establish deterministic routing and accounting behavior. User-run interactive Claude Code checks establish the remaining client behavior.
