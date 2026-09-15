# Provider contracts

## GitHub Copilot HTTP contract

Leverframe keeps GitHub device authorization and the existing credential store. It sends the GitHub OAuth token directly to `https://api.githubcopilot.com` for model discovery and inference. It does not use a GitHub runtime or exchange the token through the legacy Copilot token endpoint.

The HTTP boundary permits only the fixed Copilot HTTPS origin and known request paths. It rejects redirects and removes unrelated authentication headers. Requests identify Leverframe rather than another editor. Error responses cannot expose the stored OAuth token.

Model discovery reads the authenticated `/models` response. Explicit endpoint metadata selects `/v1/messages`, `/responses`, or `/chat/completions`. Missing or unsupported endpoint metadata leaves transport unconfirmed: the model is excluded with diagnostics, never assumed to support Chat Completions. Non-chat models stay outside the catalog.

Malformed individual records are skipped with diagnostics while valid live records are retained. Request failures, invalid top-level catalog responses, and catalogs with no usable models retain the previous cache as a visibly stale browsing fallback, not as live execution authorization.

Model availability is independent of confirmed context metadata. Live supported models with unknown context limits remain selectable by their bare IDs, without fabricated limits or context overrides. Model browsing refreshes discovery and reports its source and last fetch time.

Only advertised capabilities and limits enter the model cache. Editor picker visibility does not imply an account policy restriction. Disabled or unconfigured model policies remain unavailable.

If the backend advertises effort labels, Leverframe retains values that the shared HTTP adapters support. These include `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Unknown labels do not become request parameters, and absent metadata stays unconfirmed.

These backend endpoints do not have a documented public inference contract. Compatibility depends on current backend behavior rather than the removed SDK contract.

`tests/github-copilot-http.test.ts` covers the credential boundary. `tests/github-copilot-provider.test.ts` covers HTTP protocol selection and caller-owned tools. `tests/copilot-models.test.ts` covers metadata rules.

## Explicit local HTTP endpoints

Local inference servers such as Ollama, LM Studio, and vLLM can use HTTP endpoints on explicitly allowed loopback or supported private-network addresses. Leverframe revalidates endpoint addresses through `src/registry/url-security.ts` before inference and rejects public HTTP destinations and metadata service destinations.

HTTP on a private network does not encrypt prompts or credentials. Configuring such an endpoint is a trust decision about that host and network. Use HTTPS unless you trust the network. The local endpoint allowance does not guarantee transport confidentiality.

`tests/url-security.test.ts` checks that Leverframe accepts loopback HTTP and rejects public HTTP. `tests/server-route-validation.test.ts` checks that invalid endpoints fail before Leverframe registers an execution.
