# Context selection

Launch Claude Code with `leverframe claude` in proxy mode. The native `/model` menu includes the freshly available external models from configured providers alongside native Anthropic models. Favorites affect ordering and aliases, not model availability.

Choose an external model to see its reported default and maximum context limits when they differ. Each model has one row. The context choice applies with the model selection. Cancel keeps the previous model and context choice.

Leverframe refreshes provider metadata when the context prompt opens. A failed refresh or missing confirmed limits prevents the external selection rather than inventing a limit. Native Anthropic model selection remains available.

The context picker uses a local authenticated callback while Claude Code retains its normal Anthropic connection. Endpoint mode is not required. The standalone `leverframe server` command does not install the Claude Code picker.

Older `--context-ceiling` preferences stay in the configuration for migration diagnostics. Leverframe ignores them when it builds the startup model configuration. Users choose context modes from Claude Code's `/model` picker after fresh discovery.

[Transport contracts](TRANSPORT-CONTRACTS.md) explain launch overrides, tool search, token refresh, and subscription connection reuse. [Provider contracts](PROVIDER-CONTRACTS.md) explain SDK-specific reasoning validation and local HTTP endpoints.
