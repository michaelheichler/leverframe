# Account pools

Leverframe manages multiple Anthropic API keys and ChatGPT/Codex OAuth accounts through the existing provider menu. Claude Code subscription credentials stay outside these pools.

## Manage accounts

Run `leverframe providers`, select Anthropic API or ChatGPT, and choose **Manage accounts**. Add an API key or sign in to another ChatGPT account. Explicit imports support `ANTHROPIC_API_KEY` and `~/.codex/auth.json`, with confirmation before import.

Give accounts recognizable names. Pin an account when you want a preferred credential, or remove an account through the same menu. Provider removal cleans up unshared managed credentials after publishing the registry change. If cleanup fails, the menu reports the pending cleanup instead of claiming full deletion.

The account view shows the latest selected account and switch reason. It never displays credential references or tokens.

## Control selection and failover

Choose **Account pool settings** in the provider menu. Both controls start on.

| Account balancing | Quota failover | Behavior |
| --- | --- | --- |
| On | On | Use observed capacity and healthy session affinity, then try another eligible account after a confirmed quota rejection. |
| On | Off | Balance new requests, but do not replay a failed request on another account. |
| Off | On | Prefer the pinned or first enabled account, allowing another account when confirmed quota blocks it. |
| Off | Off | Use the pinned or first enabled account without automatic alternates. |

Every alternate stays within the same provider and model while preserving the billing type. Healthy sessions keep their account. Missing or incompatible capacity measurements use fair rotation, while comparable quota windows guide selection without mixing token counts and request counts.

Provider response headers and supported Codex rate-limit events supply capacity observations. Token usage does not establish remaining subscription allowance. Several API keys can share a quota, and the pool does not count them as independent capacity without evidence.

## Exhaustion and active requests

A confirmed quota rejection can trigger another account before the response starts. Ambiguous failures and client-visible output prevent replay. Main agents and subagents receive the affected pool error on their next request. Existing healthy streams continue, including after account or provider removal.

Errors report confirmed reset information when available. A local cooldown can permit a recovery attempt on a later incoming request when the provider gives no reset time. Leverframe does not send standalone prompts to probe quota.

## Transport boundary

Pool-managed ChatGPT requests use HTTP. The existing WebSocket path has separate retry and continuation replay behavior, which cannot currently meet the pool's no-ambiguous-replay contract. Non-pool routes keep their configured transport.

Changing an account's credential reference clears its old account-local capacity state. Refreshing an OAuth access token under the same reference keeps quota observations. Old unversioned state starts unknown because it cannot establish the prior credential identity.

## Verification

The deterministic suite uses fake upstreams and isolated credential storage. Agent runs exclude `tests/live-*.test.ts` and never run a Claude conversation. The user explicitly approved Caliber's existing Anthropic API calls as the exception for context refresh and commit hooks.

The installed-binary test currently fails at `tests/patch-native-e2e.test.ts:54` on this baseline during model-schema patching, before its allowed version probe. That existing compatibility issue remains separate from account-pool behavior.

`node scripts/verify-package-contents.mjs` verifies the built package directly. On this host `pnpm check:package` stops with npm EALLOWSCRIPTS, while the same verifier passes when run directly. No npm or hook settings changed for verification.
