# Leverframe

Leverframe bridges Claude Code to external model providers through Anthropic and OpenAI-compatible APIs. It preserves tools, skills, agents, prompt caching, model switching, and auto-compaction.

Supported provider setups include:

- OpenAI API keys
- ChatGPT/Codex plan OAuth
- GitHub Copilot subscription OAuth
- OpenCode Go subscription
- Kimi Coding Plan
- Moonshot pay-as-you-go
- z.ai Coding Plan
- custom OpenAI-compatible endpoints

Leverframe can also run as a local Anthropic-format or OpenAI-compatible endpoint for other clients.

![Model picker](./docs/model-picker.png)

## Install from a checkout

Node.js 22 or newer and pnpm are required.

```bash
pnpm install
pnpm build
npm link
leverframe --version
```

The package name is `@michaelheichler/leverframe`. It installs the `leverframe` and `leverframe-claude` bins. There is no old-name executable alias.

## Quick start

### ChatGPT/Codex plan

```bash
leverframe providers auth openai
leverframe models
leverframe models --alias sol=leverframe:openai-oauth:gpt-5.6-sol
leverframe patch
leverframe claude
```

ChatGPT/Codex model context limits come from positive finite `context_window` values reported by the authenticated provider. Missing or invalid values remain unconfirmed. Leverframe does not present a seed or heuristic as a provider limit. An unconfirmed limit omits the `[1m]` suffix and the `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override.

The same endpoint also reports `max_context_window`, the maximum a model accepts, which is often far above the window it serves by default. Opt a model in with `leverframe models --context-ceiling <model-id>`, then re-run `leverframe patch`. Run it with an unknown model id to list the models that currently offer more. The maximum is read live per account and is never bundled, because it differs between accounts and between models on one account. Long-context requests are usually billed at a higher rate, which is why nothing is applied automatically.
### GitHub Copilot subscription
```bash
leverframe providers auth github-copilot
leverframe models
leverframe models --alias copilot=leverframe:github-copilot:<model-id>
leverframe patch
leverframe claude --proxy
```
Device authorization uses Leverframe's public OAuth App client ID. Each user authorizes their own GitHub account. The durable GitHub token stays in that user's OS credential store.
Leverframe does not store a GitHub account, subscription, short-lived Copilot token, or static model catalog. Model refresh uses the public SDK. It lists only models available to the authorized account.
`@github/copilot-sdk@1.0.9` is optional and stays outside the Leverframe bundle. A normal package install attempts to install the SDK and its platform binary. A missing optional install fails only the Copilot route and provides an install command.
Copilot sessions have these limits:
- `tool_choice: auto` exposes only the request's custom tools.
- `tool_choice: none` exposes no tools.
- `required` and named-tool choices fail before runtime or session creation.
- Transcript divergence creates a new isolated session with a versioned resync.
- Session events and checkpoints use an in-memory filesystem.
Built-in tools, memory, skills, plugins, instruction discovery, MCP servers, session search, host Git operations, and repository context stay disabled.
A rejected durable GitHub token is not refreshed as an OpenAI token. Reauthorize with `leverframe providers auth github-copilot`. Short-lived Copilot session credentials remain owned by the official SDK.
Use `leverframe claude --endpoint` instead of `--proxy` to verify the same alias through endpoint mode.
### API-key providers

```bash
leverframe providers add
leverframe models
leverframe claude
```

`providers add` supports OpenAI, OpenCode Go, Kimi Coding Plan, Moonshot, z.ai Coding Plan, and custom OpenAI-compatible endpoints. Credentials stay separate because each provider has its own endpoint and billing arrangement.

### OpenCode Go subscription

```bash
leverframe providers add
leverframe models
leverframe claude
```

Adding OpenCode Go validates the key and loads current model metadata. Run `leverframe providers refresh-models opencode-go` later to update it.

Leverframe resolves Go metadata at refresh time from supplier-maintained sources:

- model availability from the authenticated OpenCode Go models API
- context windows and capabilities from [models.dev](https://models.dev/providers/opencode-go/)
- protocols, prices, and included usage from [OpenCode's Go documentation](https://opencode.ai/docs/go/)

No Go model list, context window, protocol, price, or usage multiplier is bundled in Leverframe. Usage multipliers are derived from the current monthly plan price and each model's included usage. Model choices show context and multiplier in brackets. Missing supplier values appear as `unconfirmed`, never as estimates.

## Model routes

The public route format is:

```text
leverframe:<provider-id>:<model-id>
```

Examples:

```text
leverframe:openai:gpt-5.4
leverframe:openai-oauth:gpt-5.6-sol
leverframe:github-copilot:<model-id>
leverframe:kimi:k3
leverframe:moonshot:kimi-k3
leverframe:zai:glm-5.2
leverframe:opencode-go:<model-id>
```

Aliases can replace a full route after being saved with `leverframe models --alias`.

## Bridge modes

Both `leverframe claude` and `leverframe server` default to proxy mode. A mode flag applies only to the current run unless paired with `--save-mode`.

- `--proxy`: selectively intercepts requests to `api.anthropic.com`. Anthropic models and Claude Code credentials pass through untouched. `leverframe:` routes and saved aliases go to their configured providers.
- `--endpoint`: runs a local Anthropic-format gateway and launches Claude Code with `ANTHROPIC_BASE_URL` pointed at it.

The Anthropic passthrough base URL is kept unchanged. Gateway and proxy responses echo the exact model id supplied by the requesting client.

```bash
leverframe claude --proxy
leverframe claude --endpoint
leverframe server --proxy
leverframe server --endpoint --quick
```

Endpoint-mode defaults:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:17645/anthropic
OPENAI_BASE_URL=http://127.0.0.1:17645/openai/v1
```

Use any API key for a local-only endpoint. Network listen mode requires the configured server password.

## Commands

```text
leverframe claude [options] [claude-flags]
leverframe server [options]
leverframe patch [--restore] [--target <path>]
leverframe patch --diagnose [--json] [--target <path>]
leverframe models
leverframe favorites
leverframe providers [add|auth|list|remove|refresh-models]
leverframe executions [list|show|reconcile]
```

`leverframe patch` makes favorites and aliases first-class Claude Code models. It updates model validation, the `/model` picker, aliases, context-window metadata, and supported effort levels.

### Bypass permissions by default

`leverframe claude -- --dangerously-skip-permissions` passes the flag through for a single run. To make every `leverframe claude` launch start in bypass-permissions mode, set it in `~/.leverframe/config.json`:

```json
{
  "launch": { "bypassPermissions": true }
}
```

This only affects `leverframe claude` launches. A `--permission-mode` or `--dangerously-skip-permissions` flag you pass explicitly always wins over the saved setting.

### Agent launch routing notice

On Claude Code 2.1.226, each new local Agent launch shows:

```text
Routing successful. Model <modelDisplay> with Reasoning <effort>
```

Both values are dynamic. `<modelDisplay>` resolves from configured Leverframe model metadata (alias or display name), then Claude Code's native display name, then the raw model identity. `<effort>` is the effective effort resolved from child permission layers and app state at request time. When the request has no explicit effort, it falls back to that model's default. This is not the declared agent frontmatter value, so it remains truthful when Claude Code ignores that declaration ([anthropics/claude-code#64706](https://github.com/anthropics/claude-code/issues/64706)).

The values use Claude Code's bold suggestion and success theme roles. The sentence retains its full meaning without color, including in screen-reader mode. The notice appears once per subagent launch. Resumed subagents do not emit a duplicate. Background subagents, the default since Claude Code v2.1.198, show it at launch, not at completion.

The notice comes from Leverframe's existing Claude Code binary patch. It is not a hook, plugin, `settings.json` change, or statusline entry, and needs no user configuration beyond the existing patch flow. Machine-readable modes such as `--output-format json` are unaffected. The notice stays in the Claude Code UI and never reaches stdout or stderr.

Binary patching requires Claude Code 2.1.223 or newer, and this feature is pinned against 2.1.226. The routing transform is optional. If Claude Code internals change and its anchors no longer match, Leverframe skips the notice while required model and effort patches keep working. Re-run `leverframe patch` after a Claude Code update to restore it when supported. The transform version moved from 3 to 4, so existing patched installations are treated as stale and re-patched on next launch through the existing stale flow. Older installations receive an upgrade instruction while proxy mode remains available.

Leverframe can rebuild a lost V2 manifest only from an independently verified pristine legacy backup. It never patches on top of unowned injected bytes.

`leverframe patch --diagnose` prints a read-only, network-free report. The report covers the resolved installation, patch and manifest state, pending transaction, and exact legacy recovery mode. `--target` pins discovery to one binary for patching and diagnostics.

`leverframe executions` inspects interrupted or ambiguous provider executions recorded under `~/.leverframe/state/executions`. `leverframe executions list` and `show <scope-hash> <execution-id>` are read-only.

`leverframe executions reconcile <scope-hash> <execution-id> --tool-call <id>|--all --executed|--not-executed` records a human-confirmed outcome for a tool call with an ambiguous client-side status. Leverframe never executes tools or guesses this outcome. Every proxy or server startup reports reconciled and expired executions without resolving them automatically.

For agents view and background-agent setup, see [docs/background-agents.md](docs/background-agents.md).

## Configuration and compatibility

- Config home: `~/.leverframe`, overridden by `LEVERFRAME_HOME`.
- Logs, runtime discovery, locks, patch state, certificates, and fallback credential data live under `~/.leverframe`.
- `LEVERFRAME_CLAUDE_PATH` overrides Claude Code binary discovery.
- `LEVERFRAME_NO_DISCOVERY=1` prevents a standalone server from registering in `~/.leverframe/server-runtime.json`.
- Provider-specific environment keys use `LEVERFRAME_KEY_<PROVIDER_ID>`.
- `LEVERFRAME_AUTO_REPLAY_MAX_RETRIES` caps automatic replays of streams that fail before any output reached the client (default 2, max 10).
- `LEVERFRAME_TOOL_EARLY_FLUSH_BYTES` (default 8000) and `LEVERFRAME_TOOL_EARLY_FLUSH_MS` (default 5000) let a still-open tool call's buffered JSON flush progressively to the client once it crosses either threshold, instead of waiting for the call to finish.
- `LEVERFRAME_TOOL_JSON_MAX_BYTES` (default 2,000,000) bounds a single tool call's buffered input JSON; exceeding it fails the request rather than growing the buffer without limit.
- `LEVERFRAME_OUTPUT_IDLE_TIMEOUT_MS` (default 45000) aborts a stream that has produced no client-visible output (text, reasoning, or tool JSON) for this long, even while the provider keeps sending other stream activity.
- Credentials use the OS credential store service `leverframe`.

On the first normal run, if `~/.leverframe` does not exist, Leverframe copies persisted state from legacy `~/.clodex` without changing or deleting the source. It can also read older relay-ai state. Credential lookup checks the `leverframe` keychain service, then legacy `clodex`, then `relay-ai`, and copies the first legacy hit into `leverframe`.

### Keychain prompts or integrity errors on macOS

Keychain approval prompts bind to the node binary, so a node upgrade makes macOS re-ask for every leverframe Keychain item once. Choose "Always Allow" on each prompt. If startup reports `keyring integrity error` or favorites show as missing credentials afterward, run:

```bash
leverframe keyring repair
```

It rebuilds each account's credential journal from the published credential and only clears entries whose credential is genuinely unreadable, telling you which ones to re-add.

## Context infrastructure status

The repository includes tested building blocks for context budgeting, request compaction, trusted metadata, encrypted memory, local inference profiling, summaries, and worker supervision. These modules are not connected to the production request path yet. Leverframe does not claim automatic custom compaction until that integration and its stream fixtures are complete.

See [docs/TESTING.md](docs/TESTING.md) for the current safety net and [docs/TECH-DEBT.md](docs/TECH-DEBT.md) for the remaining integration work.

## Known limitations

- Claude Code applies its own pricing table, so its displayed cost can be inaccurate for non-Anthropic models.
- In endpoint mode, Claude Code fetches context metadata at startup and may not refresh it after a live `/model` switch.
- ChatGPT/Codex OAuth requires `store: false` upstream. Some OpenAI cache controls are omitted on OAuth routes because compatibility testing found empty responses with them.

## Provenance and license

Leverframe is MIT-derived from [clodex](https://github.com/bman654/clodex) and [relay-ai](https://github.com/jacob-bd/relay-ai). See [LICENSE](LICENSE) for the license and required copyright notices.
