# Context selection

In Claude endpoint mode, Claude Code shows one row for each external model. If fresh provider discovery reports a default context and a larger maximum, the model row opens a second prompt with both reported values.

Leverframe refreshes provider metadata through its loopback context endpoint whenever the context prompt opens. A failed refresh or a response without confirmed limits cancels the selection and keeps the current model. Endpoint mode applies the default limit at launch and applies the maximum only after the user selects that mode.

Proxy bridge mode keeps Anthropic authentication through the MITM proxy and has no context selection endpoint. Its picker therefore omits the secondary context choices. The standalone `leverframe server` command exposes model metadata through server routes but does not provide the Claude Code picker.

Older `--context-ceiling` preferences stay in the configuration for migration diagnostics. Leverframe ignores them when it builds the startup model configuration. Users choose context modes from Claude Code's `/model` picker after fresh discovery.

[Transport contracts](TRANSPORT-CONTRACTS.md) explain launch overrides, tool search, token refresh, and subscription connection reuse. [Provider contracts](PROVIDER-CONTRACTS.md) explain SDK-specific reasoning validation and local HTTP endpoints.
