# Context selection

Claude Code shows one row for each external model. If fresh provider discovery reports a default context and a larger maximum, the model row opens a second prompt with both reported values.

Leverframe refreshes provider metadata whenever the context prompt opens. A failed refresh or a response without confirmed limits cancels the selection and keeps the current model. The proxy applies the default limit at launch and applies the maximum only after the user selects that mode.

Older `--context-ceiling` preferences stay in the configuration for migration diagnostics. Leverframe ignores them when it builds the startup model configuration. Users choose context modes from Claude Code's `/model` picker after fresh discovery.
