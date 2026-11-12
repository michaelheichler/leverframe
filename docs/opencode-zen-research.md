# OpenCode Zen access research

Checked 2026-11-04 against official documentation and public model metadata. The initial research made no inference requests. Implementation verification later sent one anonymous request, recorded below, without running Claude or accessing account credentials. Live configuration stayed untouched.

## Decision

The requested combination of free Zen chat models, no OpenCode client, and a supported integration is currently unavailable. The current inference documentation explicitly says other clients receive HTTP 403 for free-tier chat models, even with an API key. OpenCode supports paid Console models and Go from other clients. This access policy blocks the proposed free-only integration. [Inference API](https://opencode.ai/v2/docs/console/api/inference/)

Keep Claude Code and Leverframe, and use a direct provider connection only for models whose provider permits that access. If Zen is mandatory, use paid Console or Go, or request explicit permission for Leverframe access. An OpenCode wrapper would still run the software the user wants to avoid. Impersonating OpenCode would make the integration depend on bypassing its client restriction.

## Supported direct access

The API accepts bearer keys from personal accounts or service accounts. Keys belong to one workspace and can expire. A restricted key with Models set to Request can list and invoke models without billing or administrative permissions. A read-only key can list models but cannot invoke them. [API overview](https://opencode.ai/v2/docs/console/api/)

| Protocol | Endpoint |
| --- | --- |
| OpenAI Chat Completions | `https://opencode.ai/inference/openai/v1/chat/completions` |
| OpenAI Responses | `https://opencode.ai/inference/openai/v1/responses` |
| Anthropic Messages | `https://opencode.ai/inference/anthropic/v1/messages` |
| Gemini | `https://opencode.ai/inference/google/v1beta/models/<model>:generateContent` |

The documented model inventory is `GET https://opencode.ai/inference/v1/models`. Usage responses include cost, including final stream usage events. These facts describe the public interface. I did not test inference compatibility. [Inference API](https://opencode.ai/v2/docs/console/api/inference/)

OpenCode publishes an official Claude Code configuration. Set `ANTHROPIC_BASE_URL=https://opencode.ai/inference/anthropic` and provide a Console key through `ANTHROPIC_AUTH_TOKEN`. Claude Code adds `/v1/messages`. The docs support paid or Go models, including non-Anthropic models through server-side translation. The Go base is `https://opencode.ai/inference/go/anthropic`. The docs warn against forwarding a Claude account login to Console. A session-specific environment avoids global settings changes. [Claude Code harness](https://opencode.ai/v2/docs/console/harnesses/claude-code/)

## Free model snapshot

A public metadata GET returned these ten chat model IDs with zero text input and output prices. All advertise Chat Completions at `https://opencode.ai/inference/openai/v1`. Their presence does not grant third-party client access. [Live model metadata](https://opencode.ai/inference/v1/models)

| Model ID | Advertised context tokens |
| --- | ---: |
| `big-pickle` | 200000 |
| `beam-free` | 1048576 |
| `flint-40b-free` | 262144 |
| `mimo-v2.6-flash-free` | 200000 |
| `nemotron-3.5-super-vl-free` | 1048576 |
| `nemotron-3.5-lightning-free` | 262144 |
| `deepseek-v4.1-flash-free` | 200000 |
| `glm-5.3-flash-free` | 200000 |
| `pulse-alpha-free` | 1048576 |
| `crouton-alpha-free` | 1048576 |

The metadata and rendered model table differ. The table lists Jev 1.13 Free and Nemotron 3 Ultra Free but omits Crouton Alpha Free. A hardcoded free catalog would miss these changes. Pulse Alpha Free is unavailable in the EU, including Germany. [Model documentation](https://opencode.ai/v2/docs/console/models/)

## Privacy and trust

Using the API removes the need to install the OpenCode client, but the hosted service and upstream provider still receive submitted content. This separates local executable exposure from remote data trust. The research establishes no claim that the client contains spyware.

The model documentation lists exceptions to its general retention policy. Big Pickle, Pulse Alpha Free, Flint 40B Free, and MiMo-V2.6-Flash Free may use collected data to improve models. Flint retains data for 30 days. Beam retains data for 30 days for safety but does not train on it. NVIDIA free endpoints are trial services that prohibit personal or confidential submissions and log use for security and improvement. The checked page provides no Crouton-specific privacy terms. [Model privacy](https://opencode.ai/v2/docs/console/models/#privacy)

The terms allow unpaid-account content to improve the service and incorporate additional service conditions. They prohibit using multiple accounts to circumvent usage limits or access restrictions. OpenCode also reserves the ability to change or discontinue services. These provisions make account rotation an unsuitable reliability strategy. [Terms of Use](https://opencode.ai/legal/terms-of-service)

The privacy policy says OpenCode passes prompts upstream without storing them, while collecting device/IP information and retaining other personal data as needed for service and business purposes. The model-specific exceptions and unpaid-account terms prevent treating that general prompt statement as a blanket zero-retention guarantee. [Privacy Policy](https://opencode.ai/legal/privacy-policy)

## Small footprint and cost controls

Go starts at $10/month. Its documented third-party client requirements are typical coding-agent traffic, an honest application user agent, and a stable conversation session ID. OpenCode validates Claude Code and recognizes its native session header. Leverframe already supports Go through `src/opencode-go-headers.ts`, which supplies its user agent and session header. That support does not grant free-tier access. The service monitors abuse and applies model-specific allowances. [Go](https://opencode.ai/v2/docs/console/go/)

For paid Console, use prepaid credits without auto-recharge. Paid calls fail with HTTP 402 when credits reach zero, and the documented balance cannot become negative. Credit purchases carry a 4.6% plus $0.31 processing fee. Go Extra Usage can spend prepaid credits after included limits, so leave it off to keep a fixed subscription cost. [Billing](https://opencode.ai/v2/docs/console/billing/)

Budgets can cap a workspace, member, or service account. Free models and included Go usage do not count toward those budgets. A zero-dollar budget blocks spend that does count. Requests already running can finish beyond a budget threshold, so budgets do not guarantee an exact spending ceiling. [Budgets](https://opencode.ai/v2/docs/console/budgets/)

I recommend the following constraints for a future integration, pending Leverframe source review.

1. Reuse an existing compatible HTTP transport, with no OpenCode dependency, subprocess, daemon, or SDK.
2. Require explicit model selection and disable paid fallback for a free-only account.
3. Cache model metadata rather than poll it before each request, and stop when the provider denies access.
4. Bound concurrency, token output, timeout, and retries. Honor server backoff rather than rotate keys or accounts.
5. Send only the context needed for the delegated task. Do not mirror the full Claude Code conversation by default.
6. Keep request bodies and credentials out of logs. Record model, status, usage, and cost only.

## Verification limits

The public metadata GET succeeded without credentials, which verifies discovery only. The initial research did not test inference. Current deployed documentation describes HTTP 403 for other clients, but I did not locate the server enforcement code in the checked public repository paths. The exact enforcement mechanism remains unknown, and older cached documentation about anonymous access does not override the deployed client restriction.

## Current client source mechanism

I inspected public source at commit `fda50433593de1e942170967678fd55e683448be`, rather than installing or executing OpenCode.

The provider plugin enables anonymous free access locally by assigning `apiKey: "public"` when no environment key, connected account, or configured key exists and the user has not disabled free models. It then disables models that advertise a positive input price when no real key exists. This is a shared public placeholder, not a user credential or subscription token. [Provider plugin, lines 426-451](https://github.com/anomalyco/opencode/blob/fda50433593de1e942170967678fd55e683448be/packages/core/src/plugin/provider/opencode.ts#L426-L451)

The bundled catalog routes free chat models such as Big Pickle and DeepSeek V4.1 Flash Free through OpenAI Chat Completions at `https://opencode.ai/inference/openai/v1`, with `reasoning_content` as the reasoning field. This matches the live model metadata response. [Bundled model catalog](https://github.com/anomalyco/opencode/blob/fda50433593de1e942170967678fd55e683448be/packages/core/src/models-dev/snapshot.txt)

The general inference request builder adds these headers to model requests. No separate Zen process supplies them. [Model request builder, lines 313-325](https://github.com/anomalyco/opencode/blob/fda50433593de1e942170967678fd55e683448be/packages/core/src/session/model-request.ts#L313-L325)

| Header | Source value |
| --- | --- |
| `x-opencode-session-id` | Session ID |
| `x-opencode-parent-session-id` | Parent session ID, when present |
| `x-session-affinity` | Session affinity |
| `X-Session-Id` | Session affinity |
| `x-parent-session-id` | Parent session ID, when present |
| `User-Agent` | Application user agent |
| `x-opencode-project` | Project ID |
| `x-opencode-session` | Session affinity |
| `x-opencode-client` | Application name |

The application constructs its user agent as `opencode/${app.channel}/${app.version}/${app.name}`. [Application source, lines 24-25](https://github.com/anomalyco/opencode/blob/fda50433593de1e942170967678fd55e683448be/packages/core/src/app.ts#L24-L25)

This source explains what the client sends. It does not prove which values the hosted server checks or establish permission for Leverframe to impersonate that client. I found no current server enforcement implementation in the inspected public source tree. A stable integration should obtain authorized API access instead of treating the public placeholder and identifying headers as a supported third-party free API.

## Experimental integration check

At the user's request, Leverframe now has an experimental `opencode-zen` provider beside Go. It uses anonymous free model discovery and sends the public placeholder credential with the source client's session headers. Its user agent is `opencode/leverframe/0.5.2/leverframe`, and `x-opencode-client` names Leverframe. Leverframe needs no OpenCode runtime or dependency.

One anonymous request on 2026-11-04 at 19:51:36 UTC sent `Reply OK` to Big Pickle with `max_tokens` set to 8. The service returned HTTP 429 with `FreeUsageLimitError` and `Retry-After: 14904`. Its message said free models work in OpenCode and suggested Go. The request used no account credentials or repository content, and no retry followed. This response does not establish whether quota or client gating caused the rejection, and it does not demonstrate working inference access.

The implementation admits only chat models with explicit zero prices and the expected HTTPS Chat Completions endpoint. Zen has no paid fallback, and it overrides custom authentication headers with the public credential. It keeps each Claude conversation's session identifiers together and disables automatic SDK retries for Zen. Go retains its existing connection.
