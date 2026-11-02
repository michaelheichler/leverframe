# Provider context and account selection

Antigravity discovery must retain valid `maxTokens` from the authenticated account catalog as the context window and `maxOutputTokens` as the output limit. Missing or invalid limits remain unconfirmed. No model-name table supplies a limit.

The Add provider menu must offer additional accounts or named configurations for every configured provider. Each account may have a display name and a unique, case-insensitive 3 to 4 character tag. Blank input generates a tag. Existing accounts receive stable generated tags without changing credential references.

Model choices must identify the provider and account, for example `Claude Sonnet (Anthropic API [WORK])`. Leverframe renders the tag in orange. Claude Code uses its supported warning color for the account badge and retains the tag in the text label. Users can rename accounts and tags in account management.

## Approaches

1. Show account tags on an automatic provider pool. This requires fewer routing changes, but the picker cannot promise which account serves a request.
2. Offer account-specific model rows alongside the existing automatic pool. Selecting `[WORK]` binds requests to that account. Automatic routing remains an explicitly labeled pool option. This meets the request for identifiable accounts and preserves current pool behavior.

The user approved approach 2 for every supported provider. Account-specific identities must remain distinct across favorites, aliases, context refresh, and inference. Selecting an account must never silently switch to another account.

## Verification

Use deterministic regressions for dynamic Antigravity limits, adding multiple credentials without replacing the first, naming and tag validation, account-specific model labels, and routing isolation. Run typecheck, lint, the test suite, build, package verification, and GitNexus change analysis. Do not launch headless Claude or perform live inference.
