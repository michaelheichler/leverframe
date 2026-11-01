# Provider capacity and local runtime evidence

Verified on 2026-11-01 through public primary sources and metadata requests. No weight downloads or inference calls supplied this evidence. Candidate models still need local quality validation.

## Anthropic API

[Rate limits](https://platform.claude.com/docs/en/api/rate-limits) distinguishes organization spend caps from rate limits. Workspaces can impose additional limits. Parse remaining capacity and reset headers for the relevant request or token bucket, and obey confirmed retry guidance. A spend-cap rejection can omit retry-after. Separate API keys do not prove separate quota.

[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing) describe automatic cache control and explicit breakpoints. Preserve client policy and stable prefixes. Default writes use a five-minute TTL, while one-hour writes cost more. Total input comprises uncached input plus cache-read and cache-creation tokens. Keep creation accounting by TTL when available.

Claude Code's [gateway caching guidance](https://code.claude.com/docs/en/prompt-caching) explains why block-form system content and cache markers must survive gateway forwarding. Its [cost guidance](https://code.claude.com/docs/en/costs) distinguishes measured session tokens from authoritative billing. Preserve model and effort settings rather than lowering them as an implicit optimization.

Anthropic's [tool-context guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context) separates tool-definition overhead from accumulated tool results. [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) can invalidate cached prefixes when it clears results. Preserve client context-management directives and opaque thinking blocks, and avoid combining independent history-rewriting policies without explicit support.

## ChatGPT and Codex

The official [rate-limit parser](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs) recognizes response headers with primary and secondary usage windows. It also parses structured rate-limit events and server-selected limit IDs. Header families include x-codex-primary-used-percent with window-minutes and reset-at fields, plus equivalent secondary fields. Reset timestamps use Unix seconds in the current source. Discover supported families without hardcoding account names or model-specific quota windows.

The official [backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs) maps backend quota snapshots separately from inference token usage. A request token count cannot establish remaining subscription capacity. Unsupported telemetry remains unknown.

The official event parser maps absent limit names to its default codex meter. Header identities come from the documented header family, so the implementation does not consume an unsupported x-codex-limit-id field.

## Local runtime candidates

[MLX LM](https://github.com/ml-explore/mlx-lm) supplies the inference library and server implementation. Its [latest release](https://github.com/ml-explore/mlx-lm/releases/tag/v0.32.2) at verification time is 0.32.2. Pin a tested version before shipping and verify structured tool calls for each artifact and chat template.

Published package metadata for [mlx-lm 0.32.2](https://pypi.org/project/mlx-lm/0.32.2/) requires Python 3.11 or later. The [mlx 0.32.2 wheels](https://pypi.org/project/mlx/0.32.2/#files) currently stop at CPython 3.14. [vLLM 0.32.0](https://pypi.org/project/vllm/0.32.0/) requires Python from 3.11 through 3.14. Managed setup must select a compatible interpreter before creating its environment.

The public Hugging Face model metadata API returned these immutable revisions. All three records report Apache-2.0 and ungated access. Those metadata fields do not establish tool-use or compaction quality.

| Candidate artifact | Immutable revision | Candidate role |
| --- | --- | --- |
| [Qwen3-Coder-Next-4bit](https://huggingface.co/mlx-community/Qwen3-Coder-Next-4bit) | 7b9321eabb85ce79625cac3f61ea691e4ea984b5 | Coding with substantial memory needs |
| [Qwen3.8-27B-OptiQ-4bit](https://huggingface.co/mlx-community/Qwen3.8-27B-OptiQ-4bit) | a95c2908fa8ca27cbf29ed86da9a658d14093b63 | Current compact coding candidate |
| [Qwen3.5-4B-OptiQ-4bit](https://huggingface.co/mlx-community/Qwen3.5-4B-OptiQ-4bit) | 4d4b423e71999777417dd587f429c9ad06e15dc0 | Compaction candidate |

The [Qwen3-Coder-Next announcement](https://qwen.ai/blog?id=qwen3-coder-next) targets coding agents and local development. Total parameters, artifact size and runtime peak memory all matter for eligibility. Active parameter count alone cannot set memory requirements. Artifact digests and precise memory measurements remain validation work.

The [Qwen3.8-27B publisher card](https://huggingface.co/Qwen/Qwen3.8-27B) describes coding and agent improvements in a 27B model. The [MLX artifact card](https://huggingface.co/mlx-community/Qwen3.8-27B-OptiQ-4bit) states that its separated vision weights allow text-only loading under stock mlx-lm. Verify that behavior and tool calls against the pinned runtime before inclusion. The earlier Qwen3.6-35B-A3B candidate remains an alternative if measured throughput justifies it.

[vLLM releases](https://github.com/vllm-project/vllm/releases) lists 0.32.0 as latest at verification time. Its [Codex integration](https://docs.vllm.ai/en/latest/serving/integrations/codex/) and [tool-calling guide](https://docs.vllm.ai/en/latest/features/tool_calling/) provide a possible NVIDIA runtime path with explicit tool parser configuration. This is a candidate library dependency, not a requirement for users to manage a separate service. Real Linux/GPU validation remains outstanding.

## Verification boundary

The development host reports Apple Silicon arm64 and 64 GiB physical RAM. Default Python does not have mlx-lm installed. Do not infer model eligibility or quality from total RAM. Use measured memory pressure and validated runtime evidence before launch.

Default deterministic tests must exclude tests/live-*.test.ts because those files can invoke headless Claude or contact providers. The installed-binary test patch-native-e2e.test.ts uses only a version probe, but currently fails during patching on this baseline. Keep that failure separate from new account-pool regressions.
