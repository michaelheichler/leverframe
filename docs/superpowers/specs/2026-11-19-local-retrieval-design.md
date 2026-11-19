# Local retrieval design

Leverframe will offer experimental, workspace-scoped retrieval for coding sessions across provider routes. It will find exact file names and identifier occurrences, return locations, and fetch short source ranges on demand. The existing evidence store continues to resolve its session references.

## Why start with locations

In the bulk-evidence experiment, agents made 18% to 34% fewer read and search calls while modeled cost rose 33% to 42% at a cache-read price of one tenth of fresh input. An exact-reference pilot preserved the cache and still raised modeled cost by 4.0% as agents ran more commands. Leverframe will compare location-first retrieval with Preserve prefix on actual coding tasks. [Context Has a Price, section 4 and appendix H](https://arxiv.org/html/2611.22238v1)

## Global constraints

- Target Node.js 22 or newer and the existing TypeScript build.
- Keep retrieval off by default. Users opt in per workspace before starting an interactive session.
- Keep retrieval local and read-only. Use no model calls, embeddings, remote index, or persistent source cache.
- Keep existing provider cache settings, system instructions, tool definitions, and request history under their existing owners. Append evidence through ordinary tool results.
- Set temporary HOME and LEVERFRAME_HOME before test imports or path resolution. Assert fixture writes stay inside the temporary directory.
- Use local fixtures and fake upstreams for automated checks. Run any Claude conversation interactively.

## Workspace retrieval

Use Git's tracked-file list for a Git worktree and read current working-tree bytes. The registered workspace must resolve to the worktree root. Search for an exact repository-relative path, basename, or case-sensitive identifier occurrence. Identifier matching is lexical and includes usages. Sort file matches first, then identifier occurrences. Within each group, sort by path and line. Return at most five rows with a repository-relative path, one-based inclusive line range, and SHA-256 digest of the file bytes. Flag `truncated` when a result or scan bound omits candidates. The agent can fall back to its usual tools.

Inspect at most 256 eligible paths per call and at most 64 KiB per file. Skip dotfile paths, private-key extensions, and common credential filenames. Check tracked membership again on read. Reject absolute or parent paths, symlink components, binary content, invalid UTF-8, and stale digests. Registration gives the agent access to eligible tracked text. The tool assumes a trusted local checkout.

Read returns at most 20 lines and 2,048 UTF-8 source bytes. Reject invalid ranges and ranges past the end of the file. Flag any clipped response. Hold up to 64 successful exact read results in memory with least-recently-used eviction and a 5-minute reuse window. Key by canonical workspace, tool contract version, path, requested range, and hash of current bytes. Validate current bytes before reuse. This saves range extraction work. Provider cache hits still depend on the upstream request.

## Agent entry point

Expose `leverframe retrieval serve --workspace <git-root>` as a stdio MCP server. The user registers it in Claude Code's local scope for that workspace. Keep two stable read-only tool definitions, `search_locations` and `read_source_range`, for the life of the process. Expose source only in tool responses as untrusted data. Keep paths, queries, and source out of diagnostics. The gateway continues to forward ordinary tool calls and results. [Claude Code local stdio servers](https://code.claude.com/docs/en/mcp)

## Evaluation and rollout

Provide an offline evaluator for one provider, route, model, and reasoning effort at a time. Compare Preserve prefix with retrieval disabled against Preserve prefix with retrieval enabled. Pair by task, repository revision, and fixture. Match harness settings and success checks. Use separate fresh sessions, warm each arm independently with the same procedure, and alternate run order across tasks. If the experiment cannot rule out shared cache contamination, report an inconclusive comparison. Include retries and failed attempts in the run totals.

Report fresh input, provider cache reads and writes, output, tool calls, repeat reads, and first-text latency. For a comparable spend metric, divide total spend including failed attempts by successful tasks. Label actual API spend, modeled API dollars, and provider-reported allowance units separately. Model dollars with explicit fresh, read, write, and output rates that match across arms. Count cache writes once. Missing counters and unlabeled amounts remain unknown. Record subscription allowance only when the provider exposes precise, isolated measurements the operator can attribute to individual runs. Cache activity and API pricing alone cannot establish ChatGPT weekly plan savings.

For the pilot, require at least 30 complete pairs, successes in both arms, and positive baseline spend. Require a point estimate of at least 10% lower spend per success and a one-sided 95% paired-bootstrap upper bound below zero for relative spend change. Require a one-sided 95% paired-bootstrap lower bound of at least minus 5 percentage points for resolution-rate change. Use 2,000 paired resamples and a fixed seed. A modeled pass supports further measurement. Widening defaults requires a separate decision supported by observed spend or allowance for the route.
