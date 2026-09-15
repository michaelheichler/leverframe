# Context selection

Launch Claude Code with `leverframe claude` in proxy mode. The native `/model` menu includes the freshly available external models from configured providers alongside native Anthropic models. Favorites affect ordering and aliases, not model availability.

Choose an external model to see its reported default and maximum context limits when they differ. Each model has one row. The context choice applies with the model selection. Cancel keeps the previous model and context choice.

Leverframe refreshes provider metadata when the context prompt opens. If live discovery confirms the model but does not report usable context limits, the picker offers **Context limits unavailable; use provider default**. Explicitly choosing it selects the bare model ID without a context override or `[maximum]`/`[1m]` marker. Previously confirmed route and runtime context limits are cleared. Cancel keeps the previous model selection.

A failed refresh, a model absent from live discovery, or a malformed callback response prevents the external selection rather than inventing a limit. Native Anthropic model selection remains available.

The authenticated `GET /v1/leverframe/context-selection?model=…` callback returns `{ model, options }` for confirmed limits. A live model with unavailable context returns HTTP 200 with `{ model, contextWindowUnconfirmed: true, options: [] }`. Only this explicit unavailable-context response permits choosing the provider default; an empty `options` array alone is not success. Failed or unconfirmed model discovery returns HTTP 503.

The context picker uses a local authenticated callback while Claude Code retains its normal Anthropic connection. Endpoint mode is not required. The standalone `leverframe server` command does not install the Claude Code picker.

Older `--context-ceiling` preferences stay in the configuration for migration diagnostics. Leverframe ignores them when it builds the startup model configuration. Users choose context modes from Claude Code's `/model` picker after fresh discovery.

Proxy launches also clear inherited `CLAUDE_CODE_MAX_CONTEXT_TOKENS` overrides, so a global limit cannot override a fresh model choice. Internal transform version 18 republishes older installed picker patches on the next launch.

[Transport contracts](TRANSPORT-CONTRACTS.md) explain launch overrides, tool search, token refresh, and subscription connection reuse. [Provider contracts](PROVIDER-CONTRACTS.md) explain SDK-specific reasoning validation and local HTTP endpoints.
