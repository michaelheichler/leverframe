# Local Retrieval Implementation Plan

> **For agentic workers:** Use the required sub-skill superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Track progress with the checkboxes.

**Goal:** Add opt-in local retrieval across Leverframe's provider routes and measure spend per resolved coding task.

**Architecture:** A workspace retriever returns locations and verifies exact source reads. A stdio MCP server exposes those tools to the coding harness. An offline command scores matched task runs.

**Tech Stack:** Node.js 22+, TypeScript, Git, Zod 4, Vitest, MCP TypeScript SDK 1.32.2.

**Spec:** [Local retrieval design](../specs/2026-11-19-local-retrieval-design.md)

## Global Constraints

- Target Node.js 22 or newer and the existing TypeScript build.
- Keep retrieval off by default. Users opt in per workspace before starting an interactive session.
- Keep retrieval local and read-only. Use no model calls, embeddings, remote index, or persistent source cache.
- Keep existing provider cache settings, system instructions, tool definitions, and request history under their existing owners. Append evidence through ordinary tool results.
- Set temporary HOME and LEVERFRAME_HOME before test imports or path resolution. Assert fixture writes stay inside the temporary directory.
- Use local fixtures and fake upstreams for automated checks. Run any Claude conversation interactively.

## Review Focus

- A dirty edit at the same Git HEAD invalidates earlier locations and read results.
- A tracked path with a symlink ancestor or credential filename cannot return source.
- A source cap inside a multibyte character preserves valid UTF-8.
- Deferred MCP tool discovery preserves earlier inputs on both representative routes.
- Failed attempts and missing allowance counters cannot make retrieval look cheaper.

---

## File map

| Path | Responsibility |
| --- | --- |
| `src/retrieval/workspace-files.ts` | Worktree root, Git inventory, and bounded file reads |
| `src/retrieval/workspace-retriever.ts` | Location ranking, range validation, and read-result cache |
| `src/retrieval/stdio-server.ts` | Stable MCP tools and stdio transport |
| `src/retrieval/evaluation.ts` | Paired-run validation, aggregation, and pilot gate |
| `src/retrieval-command.ts`, `src/cli.ts`, `src/cli-help.ts` | Local subcommands, dispatch, and help |
| `package.json`, `pnpm-lock.yaml` | Exact SDK dependency |
| `tests/workspace-retriever.test.ts`, `tests/retrieval-command.test.ts`, `tests/retrieval-evaluation.test.ts`, `tests/retrieval-prefix.test.ts` | Source, MCP, accounting, and gateway fixtures |
| `docs/local-retrieval.md`, `docs/backend-caching.md` | Workspace setup and pilot procedure |

## Execution setup

Read `CALIBER_LEARNINGS.md` and use the Vitest home fixture. Run `pnpm build` before testing a fresh checkout. Check GitNexus status and run upstream impact for each existing symbol before editing it. Task 2 touches `main` and `rootHelpText`. Report HIGH or CRITICAL risk before editing and check unresolved callers independently. For each authorized commit, stage only owned hunks and run `node .gitnexus/run.cjs detect-changes --scope all --repo .` before committing. Investigate partial or truncated graph results first.

### Task 1. Retrieve bounded, current source evidence

**Files:** Create `src/retrieval/workspace-files.ts`, `src/retrieval/workspace-retriever.ts`, and `tests/workspace-retriever.test.ts`.

**Interfaces**

- `openWorkspace(root: string): Promise<WorkspaceFiles>` returns canonical `root: string`, `list(): Promise<string[]>`, and `read(path: string): Promise<Buffer | null>`.
- `createWorkspaceRetriever(root: string, now?: () => number): Promise<WorkspaceRetriever>` returns `search(query: string): Promise<SearchResult>` and `read(location: SourceLocation): Promise<ReadResult>`.
- `SourceLocation` contains `path: string`, `startLine: number`, `endLine: number`, and `sha256: string`. `SearchResult` contains `locations: SourceLocation[]` and `truncated: boolean`. `ReadResult` is `{ status: 'ok'; location: SourceLocation; text: string; truncated: boolean }` or `{ status: 'unavailable' | 'stale' | 'invalid-range' }`.

- [ ] Add these tests with temporary Git fixtures.

  ```ts
  // finds_exact_locations_without_source
  expect(result.locations.map(row => row.path)).toEqual(['a/example.ts', 'b/example.ts'])
  expect(JSON.stringify(result)).not.toContain('PRIVATE_FIXTURE_LINE')
  // bounds_search_results_and_corpus
  expect(capped.locations).toHaveLength(5)
  expect(capped.truncated).toBe(true)
  expect(overCorpusLimit.truncated).toBe(true)
  expect(exactPathBeyondScanLimit.locations[0]?.path).toBe('z/target.ts')
  // invalidates_a_cached_read_after_a_dirty_edit
  expect(await retriever.read(locationBeforeEdit)).toEqual({ status: 'stale' })
  // rejects_escapes_and_sensitive_paths
  expect(await retriever.read(symlinkLocation)).toEqual({ status: 'unavailable' })
  expect(await retriever.read(trackedCredential)).toEqual({ status: 'unavailable' })
  expect(await retriever.read(parentPath)).toEqual({ status: 'unavailable' })
  // clips_multibyte_source
  expect(Buffer.byteLength(clipped.text)).toBeLessThanOrEqual(2048)
  expect(clipped.text).not.toContain('\ufffd')
  expect(clipped.truncated).toBe(true)
  // expires_and_evicts_exact_reads
  expect(readWithinFiveMinutes).toBe(initialRead)
  expect(readAtFiveMinutes).not.toBe(initialRead)
  expect(firstRangeAfter64NewKeys).not.toBe(initialRead)
  ```

- [ ] Run `pnpm exec vitest run tests/workspace-retriever.test.ts`. Expect a missing module failure.
- [ ] Implement `openWorkspace`. Use Git argument arrays, `git ls-files --cached -z`, and literal pathspecs for membership checks. Deduplicate paths. Skip hidden segments, `.pem`, `.key`, `.p12`, `.pfx`, `credentials.json`, `secrets.json`, `id_rsa`, and `id_ed25519`, regardless of case. Reject symlink components and non-regular files. Bound descriptor reads to 64 KiB plus one detection byte. Reject null bytes and invalid UTF-8.
- [ ] Implement `createWorkspaceRetriever`. Trim queries and accept 1 to 256 UTF-8 bytes. Inspect exact path and basename matches before scanning for identifiers. Emit line 1 for file matches and one row per matching line for identifiers delimited by characters outside `[A-Za-z0-9_$]`. Apply the design's scan and response caps. Hash raw bytes to lowercase SHA-256 hex and use tool contract version `1` in the read cache key.
- [ ] Repeat the focused test command. Expect all retrieval fixtures to pass.
- [ ] For authorized execution, commit the three paths as `feat: add bounded workspace retrieval` after the graph check.

### Task 2. Expose the workspace tools through MCP

**Files:** Create `src/retrieval/stdio-server.ts`, `src/retrieval-command.ts`, and `tests/retrieval-command.test.ts`. Modify `src/cli.ts`, `src/cli-help.ts`, `package.json`, and `pnpm-lock.yaml`.

**Interfaces**

- Consumes `createWorkspaceRetriever(root)` and `WorkspaceRetriever` from Task 1.
- Produces `serveRetrieval(retriever: WorkspaceRetriever): Promise<void>` and `runRetrievalCommand(args: string[]): Promise<number>` for `serve --workspace <git-root>` and `--help`.
- `search_locations` takes `{ query: string }`. `read_source_range` takes `SourceLocation`. Return `SearchResult` or `ReadResult` in one JSON-encoded MCP text block.

- [ ] Add a CLI test that communicates with the built binary over stdio. Use a small JSON-RPC fixture client for this test to keep the red assertion independent of the SDK install.

  ```ts
  // lists_stable_read_only_tools_and_resolves_a_location
  expect(firstTools.map(tool => tool.name)).toEqual(['search_locations', 'read_source_range'])
  expect(secondTools).toEqual(firstTools)
  expect(firstTools.every(tool => tool.annotations?.readOnlyHint)).toBe(true)
  expect(readResult).toMatchObject({ status: 'ok', text: 'export const marker = 1' })
  expect(exitAfterClosingStdin).toBe(0)
  // rejects_invalid_roots_and_lists_help
  expect(invalidWorkspace.exitCode).toBe(1)
  expect(invalidWorkspace.stdout).toBe('')
  expect(rootHelp).toContain('leverframe retrieval')
  ```

- [ ] Run `pnpm build && pnpm exec vitest run tests/retrieval-command.test.ts`. Expect the CLI to reject the unknown command.
- [ ] Add the SDK with `pnpm add --save-exact @modelcontextprotocol/sdk@1.32.2`.
- [ ] Implement `serveRetrieval` with the SDK and Zod. Use flat input schemas, a 64-character lowercase hex digest, and fixed descriptions. Reject extra input keys. Reserve stdout for protocol frames and omit source, queries, and paths from diagnostics.
- [ ] Implement `runRetrievalCommand` with sanitized errors and help. In `main`, dynamically import the command only for `retrieval`, before provider initialization. Load the MCP SDK only for `serve`. Advertise the command in `rootHelpText`.
- [ ] Repeat the build and focused test command. Expect the CLI fixtures to pass.
- [ ] For authorized execution, commit the seven paths as `feat: expose local retrieval over MCP` after the graph check.

### Task 3. Evaluate paired runs offline

**Files:** Create `src/retrieval/evaluation.ts` and `tests/retrieval-evaluation.test.ts`. Modify `src/retrieval-command.ts` and `tests/retrieval-command.test.ts`.

**Interfaces**

- Extend `runRetrievalCommand` with `evaluate --input <report-input.json>`. Print one JSON report and return 0 for valid input or 1 for invalid input.
- `evaluateRetrieval(input: unknown): EvaluationReport` accepts one experiment with `provider`, `route`, `model`, and `effort` strings, `cacheIsolation: 'verified' | 'unknown'`, a metric descriptor, and `pairs`.
- Each pair contains `taskId`, `revision`, `fixture`, and two arm records, `baseline` and `retrieval`. Each arm has `resolved: boolean`, `attempts: number`, and nullable numeric `freshInput`, `cacheReadInput`, `cacheWriteInput`, `output`, `toolCalls`, `repeatReads`, `firstTextMs`, and `observedSpend`. Sum counters and spend across attempts. Record first-text latency from the first attempt.
- Metrics are `{ kind: 'actual-usd' }`, `{ kind: 'allowance'; unit: string }`, or `{ kind: 'modeled-usd'; ratesPerMillion: { fresh: number; read: number; write: number; output: number } }`.
- `EvaluationReport` contains experiment identity, metric, pair count, `baseline` and `retrieval` aggregates with totals, median first-text latency, success rate and `spendPerResolved`, plus relative spend change, resolution-rate change, bootstrap bounds, and `outcome: 'pilot-pass' | 'pilot-fail' | 'inconclusive'`. Represent unavailable numbers with null.

- [ ] Add failing evaluator and CLI assertions.

  ```ts
  // includes_failed_task_spend
  expect(report.baseline.spendPerResolved).toBe(10) // 4 on success plus 6 on failure
  // leaves_missing_allowance_unknown
  expect(incomplete.retrieval.spendPerResolved).toBeNull()
  expect(incomplete.outcome).toBe('inconclusive')
  // charges_cache_writes_once
  expect(modeled.baseline.spendPerResolved).toBeCloseTo(0.004)
  // enforces_cost_quality_and_isolation
  expect(ninePercentCheaper.outcome).toBe('pilot-fail')
  expect(qualityRegression.outcome).toBe('pilot-fail')
  expect(sharedCache.outcome).toBe('inconclusive')
  expect(only29Pairs.outcome).toBe('inconclusive')
  expect(zeroResolved.outcome).toBe('inconclusive')
  expect(thirtyCompletePairs.outcome).toBe('pilot-pass')
  expect(evaluateRetrieval(completeInput)).toEqual(thirtyCompletePairs)
  expect(() => evaluateRetrieval(duplicateTaskIds)).toThrow()
  // prints_a_report_offline
  expect(JSON.parse(command.stdout).outcome).toBe('pilot-pass')
  ```

  For modeled writes, price 1,000 fresh, 2,000 read, 1,000 write, and zero output tokens at rates of 1, 0.5, 2, and 1 dollars per million. For the passing fixture, use 30 successful pairs with spends of 10 and 8. To test the quality gate independently, use retrieval spend 6 and mark six retrieval runs unresolved.

- [ ] Run `pnpm build && pnpm exec vitest run tests/retrieval-evaluation.test.ts tests/retrieval-command.test.ts`. Expect the evaluator import and new subcommand to fail.
- [ ] Implement `evaluateRetrieval` with Zod. Reject duplicate task IDs, invalid amounts, and noninteger counts. Require at least one attempt. Use all spend in each arm's numerator and all successes in its denominator. Propagate missing values. Draw 2,000 complete paired resamples with replacement using seed 20261119 and nearest-rank 5th and 95th percentiles. Treat undefined spend deltas as positive infinity when finding the upper bound. An infinite bound yields null and an inconclusive outcome. Apply the spec's cost and quality gates.
- [ ] Implement the `evaluate --input` handler. Read the supplied JSON file and print validated aggregates without raw events or session IDs.
- [ ] Repeat the build and focused test command. Expect the accounting and CLI fixtures to pass.
- [ ] For authorized execution, commit the four paths as `feat: evaluate paired retrieval runs offline` after the graph check.

### Task 4. Verify prefix preservation and document the pilot

**Files:** Create `tests/retrieval-prefix.test.ts` and `docs/local-retrieval.md`. Modify `docs/backend-caching.md`.

**Interfaces**

- Consumes the MCP response format from Task 2 and evaluation input from Task 3.
- Produces the gateway fixture and the workspace setup and pilot guide.

- [ ] Add a fake-upstream fixture for ChatGPT Plan and the OpenAI-compatible route. Reuse the request capture patterns in `tests/openai-chatgpt-plan-append-only-tools.test.ts` and `tests/compatible-cache-usage-route.test.ts`. Compare requests inside each route. Include deferred discovery and use the route's existing tool registration semantics.

  ```ts
  // forwards_retrieval_after_the_preserved_prefix
  expect(JSON.stringify(nextPrefix)).toBe(JSON.stringify(firstPrefix))
  expect(nextToolResult).toContain('retrieval_fixture_marker')
  expect(JSON.stringify(firstRequest)).not.toContain('retrieval_fixture_marker')
  // keeps_retrieval_off_by_default
  expect(JSON.stringify(defaultRequest)).not.toContain('search_locations')
  ```

- [ ] Run `pnpm build && pnpm exec vitest run tests/retrieval-prefix.test.ts tests/openai-chatgpt-plan-append-only-tools.test.ts tests/compatible-cache-usage-route.test.ts`. Expect the current transport to preserve earlier messages. If a route rewrites the prefix, capture the mismatch and run upstream impact before proposing a transport edit.
- [ ] Write `docs/local-retrieval.md`. Document `claude mcp add --transport stdio --scope local leverframe-retrieval -- leverframe retrieval serve --workspace "$PWD"` from the Git root, followed by interactive Leverframe startup. Include `claude mcp remove --scope local leverframe-retrieval`, file eligibility, model-visible data, and the fallback for capped search.
- [ ] Add sample evaluation input and the 30-pair pilot procedure to the guide. Describe separate warming, order alternation, the common retry budget, and route-specific usage or receipt measurement. Map provider counters to disjoint fresh, cache-read, and cache-write inputs using the existing usage docs. Record missing ChatGPT weekly allowance as unknown.
- [ ] Link the guide from the retrieval experiment section of `docs/backend-caching.md`.
- [ ] Run `pnpm build && pnpm typecheck && pnpm test && pnpm check:package`. Expect local checks to pass. Keep live savings pending until interactive measurements exist.
- [ ] For authorized execution, commit the three owned paths as `test: verify retrieval prefix and document pilot` after the graph check.
