# Provider contracts

## Copilot reasoning efforts

Leverframe validates Copilot requests against the installed public `@github/copilot-sdk` contract. Version 1.0.9 defines `ReasoningEffort` as `low`, `medium`, `high`, `xhigh`, or `max` in `dist/types.d.ts`. Its supported and default effort fields use that type.

The shared registry type also contains values used by other providers. That broader type does not establish Copilot support for those values. The generated RPC layer accepts provider-defined strings, but this does not expand the public SDK contract for Copilot models. Validation remains specific to the provider until its supported contract changes.

`tests/copilot-models.test.ts` and `tests/copilot-language-model-validation.test.ts` verify this boundary.

## Explicit local HTTP endpoints

Local inference servers such as Ollama, LM Studio, and vLLM can use HTTP endpoints on explicitly allowed loopback or supported private-network addresses. Leverframe revalidates endpoint addresses through `src/registry/url-security.ts` before inference and rejects public HTTP destinations and metadata service destinations.

HTTP on a private network does not encrypt prompts or credentials. Configuring such an endpoint is a trust decision about that host and network. Use HTTPS unless you trust the network. The local endpoint allowance does not guarantee transport confidentiality.

`tests/url-security.test.ts` checks that Leverframe accepts loopback HTTP and rejects public HTTP. `tests/server-route-validation.test.ts` checks that invalid endpoints fail before Leverframe registers an execution.
