# Claude Code guide

## Launch modes

`leverframe claude` defaults to proxy mode. It routes external model identities and aliases to their configured providers while retaining native Anthropic subscription routing. Normal proxy launch exposes the fresh external catalog, including models outside favorites.

`leverframe claude --endpoint` launches a local Anthropic-format gateway for that session. Its picker contains the starting model and saved favorites, up to 20 routes. Claude Code can retain startup context metadata after a model switch in this mode.

A mode flag applies to the current run. Add `--save-mode` to retain it.

The packaged `claudeplus` launcher starts a private `leverframe server --proxy --prepare-claude` for each session. A startup lock serializes patch preparation. Each session has its own proxy port, settings, and logs. It removes inherited global context overrides from private session settings and uses provider metadata instead.

## Native patch

`leverframe patch` integrates the cached provider catalog, favorites, and aliases into model validation, the picker, context metadata, supported effort levels, and Agent descriptions. Account tags retain text labels and use orange badges when the picker supports the badge anchor.

Transform version 26 adds account badges. Version checks and patch diagnostics verified Claude Code 2.1.314 on macOS and Linux for release 0.5.1. Future layouts may require updated anchors. Required anchor failures block patch publication.

```bash
leverframe patch
leverframe patch --diagnose --json
leverframe patch --target /path/to/claude
leverframe patch --restore
```

Diagnostics are read-only and network-free. They report installation identity, cached catalog state, integration capabilities, hashes, pending transactions, and expired OAuth credentials. Patching retains an immutable baseline and journals changes for recovery. Re-run it after updating Claude Code.

Agent launch notices identify the agent type, resolved model, and effective effort. Notices stay in the interactive UI and preserve machine-readable output. Claude Code uses its own pricing table, so its displayed cost can differ from the external provider bill.

## Configuration

The default directory is `~/.leverframe`. It holds preferences, model metadata, logs, runtime state, patch records, certificates, and fallback credential data. Credentials normally use the OS credential store service `leverframe`.

| Variable | Purpose |
| --- | --- |
| `LEVERFRAME_HOME` | Choose another configuration directory. |
| `LEVERFRAME_CLAUDE_PATH` | Choose the Claude Code installation. |
| `CLAUDEPLUS_CLAUDE_PATH` | Override the Claude executable for `claudeplus`. |
| `CLAUDEPLUS_LEVERFRAME_PATH` | Override the Leverframe executable for `claudeplus`. |
| `LEVERFRAME_KEY_<PROVIDER_ID>` | Supply a provider-level credential. Named accounts retain their own credential binding. |
| `LEVERFRAME_NO_DISCOVERY=1` | Prevent a standalone server from publishing runtime discovery. |

The first normal run can migrate legacy `~/.clodex` or `~/.relay-ai` state while preserving the source. Credential lookup can migrate entries from the legacy credential-store services.

Pass launch flags for one session after `--`.

```bash
leverframe claude -- --dangerously-skip-permissions
```

To save that preference, set `launch.bypassPermissions` to `true` in `~/.leverframe/config.json`. Explicit launch flags take precedence.

## Streaming controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `LEVERFRAME_AUTO_REPLAY_MAX_RETRIES` | 2, maximum 10 | Bound replays before any output reaches the client. |
| `LEVERFRAME_TOOL_EARLY_FLUSH_BYTES` | 8000 | Start progressive tool JSON output at this size. |
| `LEVERFRAME_TOOL_EARLY_FLUSH_MS` | 5000 | Start progressive tool JSON output after this interval. |
| `LEVERFRAME_TOOL_JSON_MAX_BYTES` | 2000000 | Reject a tool input that exceeds this size. |
| `LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS` | 45000 | Abort after this interval without client-visible output. |

The HTTP proxy permits 600 seconds between output chunks. Partial output and visible tool calls prevent replay.

## Recovery

On macOS, Keychain approvals bind to the Node executable. A Node upgrade can trigger approval prompts. If Leverframe reports a Keychain integrity error, run `leverframe keyring repair` and follow its account-specific diagnostics.

`leverframe executions list` and `leverframe executions show` inspect interrupted or ambiguous executions. The `reconcile` command records a human-confirmed tool outcome. It does not execute tools or infer their results.

Read [accounts](account-pools.md) for account setup and pool behavior, and [context modes](CONTEXT-SELECTION.md) for context selection.
