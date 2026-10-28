# Provider contracts

## GitHub Copilot HTTP contract

Leverframe keeps GitHub device authorization and the existing credential store. It sends the GitHub OAuth token directly to `https://api.githubcopilot.com` for model discovery and inference. It does not use a GitHub runtime or exchange the token through the legacy Copilot token endpoint.

The HTTP boundary permits only the fixed Copilot HTTPS origin and known request paths. It rejects redirects and removes unrelated authentication headers. Requests identify Leverframe rather than another editor. Error responses cannot expose the stored OAuth token.

Model discovery reads the authenticated `/models` response. Explicit endpoint metadata selects `/v1/messages`, `/responses`, or `/chat/completions`. When endpoint metadata is missing or unsupported, discovery excludes the model with diagnostics instead of assuming Chat Completions support. Non-chat models stay outside the catalog.

Discovery skips malformed records with diagnostics and retains valid live records. Request failures, invalid top-level catalog responses, and catalogs with no usable models retain the previous cache as a visibly stale browsing fallback, not as live execution authorization.

Model availability is independent of confirmed context metadata. Live supported models with unknown context limits remain selectable by their bare IDs, without fabricated limits or context overrides. Model browsing refreshes discovery and reports its source and last fetch time.

Only advertised capabilities and limits enter the model cache. Editor picker visibility does not imply an account policy restriction. Disabled or unconfigured model policies remain unavailable.

If the backend advertises effort labels, Leverframe retains values that the shared HTTP adapters support. These include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Unknown labels do not become request parameters, and absent metadata stays unconfirmed.

These backend endpoints do not have a documented public inference contract. Compatibility depends on current backend behavior rather than the removed SDK contract.

`tests/github-copilot-http.test.ts` covers the credential boundary. `tests/github-copilot-provider.test.ts` covers HTTP protocol selection and caller-owned tools. `tests/copilot-models.test.ts` covers metadata rules.

## Anthropic API key provider

The `anthropic-api` provider bills an Anthropic API key and sits beside the Claude Code subscription. The id `anthropic` stays reserved for subscription traffic, so the API provider never shares it.

Model discovery pages through `GET /v1/models?limit=1000` with `after_id` until `has_more` is false. Only `active` models enter the cache, and a missing `lifecycle` counts as active for Anthropic-compatible servers. `display_name` becomes the label, `max_input_tokens` the confirmed context window, and `max_tokens` the output limit. Null limits stay unconfirmed.

The picker shows these models under their `leverframe:anthropic-api:<model>` identity. Bare `claude-*` ids keep routing to the subscription, and the native context picker table never receives a bare key for this provider. Leverframe relays requests in native Messages format with the API key and drops `oauth-*` and `claude-code-*` beta values. The subscription token never reaches this route.

API requests remove Claude Code client headers, the billing line, and recognized device/account/session user metadata. The standard Claude Code identity sentence becomes "You are a coding assistant." Other instructions, user content, tool definitions, and tool results retain their meaning. Anthropic OAuth requests retain their required client identity. This normalization removes known identifiers, but does not guarantee anonymity or improved model performance.

Picker rows for this provider carry `badge: "API"`. An optional patch renders the badge in the theme purple (`autoAccept`) inside the Select description cell. When the anchor is missing or ambiguous, the patch skips and the label keeps its `(Anthropic API)` suffix.

`tests/anthropic-models-fetch.test.ts` covers discovery. `tests/http-proxy-native-model-routing.test.ts` and `tests/patch-transforms-picker.test.ts` cover subscription isolation. `tests/upstream-forward.test.ts` covers the beta headers, and `tests/patch-select-badge.test.ts` covers the badge.

## ChatGPT instructions and reasoning signatures

Both ChatGPT request translators normalize the Claude Code billing line and identity sentence in system and developer instructions. User messages, tool descriptions, and tool results remain unchanged. Public OpenAI API translation retains its existing instruction behavior.

Leverframe marks OpenAI encrypted reasoning signatures before sending them through the Anthropic response format. Only marked signatures become OpenAI encrypted reasoning on replay. Native Claude signatures and unmarked signatures from older sessions do not cross that boundary. OpenAI signatures do not become Google thought signatures. This prevents foreign signature replay without deleting user messages or tool exchanges. It does not validate upstream ciphertext or guarantee replay across different accounts or providers.

`tests/neutral-anthropic-request.test.ts`, `tests/neutral-openai-request.test.ts`, and `tests/reasoning-signature-provenance.test.ts` cover these boundaries.

## Credential reads during discovery

Catalog loading reads a fresh OAuth credential once for its access token, account ID, and provider metadata. It skips disabled providers. The server startup existence check reads registry configuration without opening Keychain. Expired or rejected tokens still use the refresh and persistence checks, and later catalog loads read current credentials instead of retaining a process-wide secret cache.

`tests/provider-keychain-reads.test.ts` checks read counts and disabled providers. `tests/resolve-provider-auth.test.ts` covers refresh, rejected tokens, and environment overrides. These changes reduce repeated access, but macOS may still prompt for access to individual Keychain items.

## Explicit local HTTP endpoints

Local inference servers such as Ollama, LM Studio, and vLLM can use HTTP endpoints on explicitly allowed loopback or supported private-network addresses. Leverframe revalidates endpoint addresses through `src/registry/url-security.ts` before inference and rejects public HTTP destinations and metadata service destinations.

HTTP on a private network does not encrypt prompts or credentials. Configuring such an endpoint is a trust decision about that host and network. Use HTTPS unless you trust the network. The local endpoint allowance does not guarantee transport confidentiality.

`tests/url-security.test.ts` checks that Leverframe accepts loopback HTTP and rejects public HTTP. `tests/server-route-validation.test.ts` checks that invalid endpoints fail before Leverframe registers an execution.
