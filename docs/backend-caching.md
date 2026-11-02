# Backend caching and account switching

Leverframe preserves cache controls and cache identity for the selected endpoint. A correctly formed request can still miss because its prefix changed, its entry expired, or the provider did not retain it. Local protocol checks cannot establish a subscription quota multiplier.

## Backend contracts

| Route | Leverframe behavior | Verification boundary |
| --- | --- | --- |
| Anthropic API Messages | Retains supported cache directives, type and TTL, plus API version and beta headers. Intentional Claude Code identity and billing-line neutralization remains in place. | Provider usage reports reads, writes and optional write lifetimes. |
| Anthropic SDK and Copilot Messages | Maps supported system, tool and message directives. A scoped transport preserves schema-valid nested tool-result controls through the SDK without changing the secure Copilot fetch boundary. | Fake upstreams prove serialization and isolation. GitHub does not publish a raw cache-marker contract for every Copilot endpoint. |
| ChatGPT/Codex OAuth | Sends a request-scoped session-affinity header and matching body cache key on Claude Messages and OpenAI chat entry points. Valid session IDs produce stable hashed keys. | The fallback hashes system instructions and tools, so unidentified sessions can share it. Provider cache hits and weekly allowance effects still require interactive observations. |
| OpenAI API | Preserves a caller cache key for a model whose actual constructor destination is OpenAI. The cached model retains that classification across environment changes. | Other gateways using the same SDK package do not inherit this capability. |
| OpenCode Go | Retains its conversation-routing header and records documented gateway cache counters by endpoint. Uncached input, reads and writes remain separate. | A model name such as Kimi or GLM does not turn a Go request into a direct vendor request. |
| Direct compatible providers | Keeps documented standard cache counters and supported Kimi Platform fields. Missing fields stay unknown in measured telemetry. | Kimi Code and Z.AI Coding Plan have distinct contracts. Leverframe does not invent vendor-specific counters for them. |

Anthropic documents explicit and automatic cache controls, supported lifetimes, prefix requirements and usage accounting in its [prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Its [Messages API schema](https://platform.claude.com/docs/en/api/http/messages) defines accepted request fields. A null directive means no marker. Malformed controls on translated Anthropic routes receive a local request error before an upstream call.

OpenAI documents automatic API caching and cache keys in its [caching guide](https://developers.openai.com/api/docs/guides/prompt-caching). The [Codex client source](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) separately identifies ChatGPT session-header affinity. These are different contracts.

OpenCode describes its session header in the [Go guide](https://dev.opencode.ai/v2/docs/console/go) and its counters in the [Inference API reference](https://dev.opencode.ai/v2/docs/console/api/inference). Gateway input excludes reads and writes, and its output already includes reasoning. Leverframe avoids adding either twice.

For direct vendors, consult the [Kimi Platform cache guide](https://platform.kimi.ai/docs/guide/context-caching), [Kimi Code documentation](https://www.kimi.com/code/docs/en/), [Z.AI cache guide](https://docs.z.ai/guides/capabilities/cache), and [Coding Plan endpoint setup](https://docs.z.ai/devpack/quick-start). GitHub's [Copilot cache guidance](https://docs.github.com/en/copilot/tutorials/optimize-ai-usage) describes product behavior rather than one universal raw request format.

## Reading usage

Measured logs preserve provider fields independently, so known cache-write lifetimes can appear even when the aggregate remains unknown. Client protocol formatting keeps its compatibility defaults separate. An omitted count establishes neither a cache hit nor a miss.

The offline regression suite uses real SDK conversion against fake HTTP and SSE responses. It covers endpoint boundaries, valid controls, malformed controls, streaming, cancellation, concurrent calls, and request isolation. Those fixtures do not measure actual provider savings.

## Account controls

Account balancing and quota failover default on, with separate switches in the existing settings menu. Add API accounts or sign in to another ChatGPT account through account management. Credential import requires an explicit confirmation. Claude Code subscription credentials do not join this pool.

The remaining-quota threshold defaults to 10 percent. Set it to 0 to disable proactive threshold switching, or choose a finite percentage below 100. Proactive switching requires both balancing and failover on, recent verified quota data, and a comparable better account. Unknown data does not become an invented balance. All-low accounts remain usable until actual limits block them.

The local freshness limit is 60 seconds for proactive comparisons. It does not claim that provider quota resets after a minute, and it does not clear blocked or authentication-failure states. Weekly-only Codex windows work without a five-hour assumption. The settings activity display retains the actual latest switch reason and timestamp across ordinary follow-up requests.

Rebuilt files affect newly started Leverframe sessions. Existing per-session proxy processes keep the code they loaded. Start a new interactive Claude Code session after installation to observe the current adapter and compare provider-reported cache usage on the same model and effort.
