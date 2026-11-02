# Accounts and automatic pools

Every configured API-key provider, supported OAuth provider, and custom endpoint supports named accounts or configurations. Native Claude Code subscription traffic continues to use Claude Code's own login.

## Add and name accounts

Run `leverframe providers add` and select **Add or manage accounts** beside your configured provider. You can also select any provider in `leverframe providers` and choose **Manage accounts**.

Choose **Add API key**, **Sign in to another account**, or **Add named configuration**, according to the provider's authentication type. Give the account a display name and a unique tag of 3 to 4 letters or digits. Leave the tag blank for automatic assignment. The tag `AUTO` names the automatic pool and cannot name an account.

Use **Rename account or change tag** to edit labels later. Favorites and aliases keep the account's stable identity when its labels change. Adding an account preserves existing credentials and catalogs.

Account tags appear in orange in Leverframe. The Claude Code patch adds orange badges when its picker supports the badge anchor, and text labels retain the tag when a terminal or picker cannot render it.

Explicit imports remain available for `ANTHROPIC_API_KEY` and `~/.codex/auth.json`. Leverframe asks before reading those sources. Account views never display credential references or tokens.

## Select an account or Auto

Each named model choice identifies its provider and account tag. Selecting `[WORK]` sends the request to that account. An unavailable, disabled, removed, or quota-blocked account produces an error instead of selecting another account.

The separate `[AUTO]` choice follows **Account pool settings**. Existing unqualified model identities retain automatic selection when account-specific rows appear.

| Account balancing | Quota failover | Auto behavior |
| --- | --- | --- |
| On | On | Use observed capacity and healthy session affinity, then try another eligible account after a confirmed quota rejection. |
| On | Off | Balance new requests without replaying a failed request on another account. |
| Off | On | Prefer the pinned or first enabled account, allowing another account when confirmed quota blocks it. |
| Off | Off | Use the pinned or first enabled account without automatic alternatives. |

Auto alternatives keep the same provider and model. Billing type also stays fixed. Explicit account choices stay fixed. When a provider reports comparable quota measurements, Auto uses them to guide selection and otherwise rotates fairly among eligible accounts. Token usage alone cannot establish remaining allowance.

With failover enabled, Auto handles confirmed credit or quota rejections inside the same request before sending any output to the client. A successful alternative hides the intermediate error. A confirmed empty account stays blocked until its credential generation changes. Leverframe sends no standalone account probes. When every eligible account has confirmed billing exhaustion, the client receives a dedicated Leverframe error with the account count rather than the raw provider credit error.

## Model catalogs and context

Leverframe refreshes each account separately and retains its exact model IDs. Capabilities and limits remain bound to that account. It does not copy one account's catalog into another account. If a refresh fails, browsing can retain that account's cached models, while fresh execution discovery excludes its stale routes.

Context windows come from provider or supplier metadata. Missing or invalid limits stay unknown. Auto uses the smallest confirmed context among eligible account catalogs for that model, and leaves the limit unknown when any participating catalog omits it. Explicit account choices retain their own reported limits and supported context modes.

Concurrent refreshes carry independent operation generations, so an older result cannot replace a newer catalog or mark it unavailable. Live launch and read-only patch diagnostics use the same account ownership checks.

## Removal and active requests

Removing an account retires its future routes and cleans up unshared managed credentials. Healthy active streams can finish. When the primary account changes, Leverframe promotes the replacement account's own catalog or clears the provider catalog until fresh discovery succeeds.

A cleanup failure leaves a pending cleanup record and appears in the menu. Leverframe does not claim full credential deletion before it verifies cleanup.

Confirmed quota rejections can trigger an Auto alternative before the response starts. Ambiguous failures and visible output prevent replay. Errors report confirmed reset information when available. Leverframe never sends standalone inference requests to probe quota.

## Verification

Deterministic tests use local upstream fixtures and isolated credentials. Agent verification excludes live Claude conversation suites. `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm check:package` check the source and distributable package without a model conversation.
