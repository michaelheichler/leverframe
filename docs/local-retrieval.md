# Local code retrieval

Leverframe offers an opt-in workspace tool for finding source by exact path, filename, or identifier. It returns up to five locations. The agent can ask for a short range from a location during an ordinary tool turn. This keeps a bulk evidence packet out of the opening prompt and lets the selected provider apply its normal cache policy.

## Enable it for one workspace

Run the following from the Git worktree root with the current Leverframe binary on your PATH, then start an interactive Leverframe session from that root.

```sh
claude mcp add --transport stdio --scope local leverframe-retrieval -- leverframe retrieval serve --workspace "$PWD"
leverframe claude
```

Claude Code stores the registration in its local scope for this project. Open `/mcp` in the session to check the connection. For ChatGPT Plan with deferred tool discovery, start Leverframe with `LEVERFRAME_OPENAI_APPEND_ONLY_TOOLS=1 leverframe claude` to use the experimental append-only tool declarations. Ordinary startup uses the route's default declaration behavior. To remove retrieval, run the following from the same root and start a fresh session. [Claude Code MCP setup](https://code.claude.com/docs/en/mcp)

```sh
claude mcp remove --scope local leverframe-retrieval
```

## What the tools can read

- Search checks current working-tree content in Git-tracked files. Identifier matching is case-sensitive and includes both definitions and usages.
- The model sees repository-relative locations and content digests. When it requests a source range, it also sees up to 20 lines and 2,048 UTF-8 bytes of source. Register only in a trusted checkout where the agent can read eligible tracked text.
- The server skips hidden, binary, untracked, oversized, and common credential files. It rejects symlink paths. Search checks at most 256 candidate files, and `truncated` tells the agent when a limit omitted candidates or clipped source.
- A location goes stale after a change to its file. Search again or use the normal workspace tools when results are missing, stale, or capped.
- The process holds up to 64 exact read results with a 5-minute reuse window. The server rechecks file bytes before reuse. Results leave memory on replacement, eviction, or shutdown.

## Run a paired pilot

1. Choose at least 30 coding tasks with fixed revisions, success checks, and a retry budget. Hold the harness, provider, route, model, and reasoning effort fixed. Evaluate each route independently.
2. Use the **Preserve prefix** cache setting for both arms. For ChatGPT Plan, enable the append-only flag in both arms. Run the baseline without the MCP registration and retrieval with it. Start separate sessions, warm each independently using the same procedure, and alternate which arm runs first. Set `cacheIsolation` to `unknown` if you cannot rule out cache sharing between the arms.
3. Use the same measurement boundary for both arms. Include every failed attempt and retry. Include any arm-specific warming requests that the measured workflow requires. Apply the same success check after each run.
4. Record final measured usage once per request. Use provider-measured uncached input for `freshInput`, cache-read input for `cacheReadInput`, and cache creation for `cacheWriteInput`. Prefer provider-reported usage to zero-filled client fields. If the provider reports an inclusive input total, subtract known reads and writes once to derive uncached input. Use null when a counter is unavailable. For routes that report different write lifetimes, keep the cache write policy and rate comparable before using modeled spend. Record first-text latency from the first attempt. [Leverframe usage and cache contracts](backend-caching.md#reading-usage)
5. Choose one spend metric. Use actual attributed API dollars, modeled dollars with explicit per-million rates, or a provider allowance unit comparable across runs. OpenCode Go can report `openCodeGoAllowanceUsd` on supported routes. Count it once per request when present. ChatGPT weekly allowance stays unknown unless you can measure and attribute it to each run. API prices alone cannot measure subscription savings.
6. Save a paired input file and run the evaluator locally.

```sh
leverframe retrieval evaluate --input retrieval-pilot.json
```

This example has one pair, so the evaluator reports an inconclusive pilot. For `modeled-usd`, supply `ratesPerMillion` with `fresh`, `read`, `write`, and `output` rates and use null for `observedSpend`.

```json
{
  "provider": "example",
  "route": "translated",
  "model": "example-model",
  "effort": "medium",
  "cacheIsolation": "verified",
  "metric": { "kind": "actual-usd" },
  "pairs": [
    {
      "taskId": "fixture-01",
      "revision": "fixture-revision",
      "fixture": "refactor-test-v1",
      "baseline": {
        "resolved": true, "attempts": 1, "freshInput": 2000,
        "cacheReadInput": 10000, "cacheWriteInput": 0, "output": 1000,
        "toolCalls": 9, "repeatReads": 2, "firstTextMs": 820, "observedSpend": 0.03
      },
      "retrieval": {
        "resolved": true, "attempts": 1, "freshInput": 1500,
        "cacheReadInput": 10000, "cacheWriteInput": 0, "output": 900,
        "toolCalls": 7, "repeatReads": 1, "firstTextMs": 800, "observedSpend": 0.026
      }
    }
  ]
}
```

The report divides all spend by the number of resolved tasks in each arm. A pilot pass requires at least 10% lower spend per resolution, a one-sided 95% upper bound below zero for the cost change, and a one-sided 95% lower bound no worse than a 5 percentage point drop in resolution. Check tool calls and fresh input alongside cost to understand what changed. The bootstrap uses the observed pairs. A small sample with identical outcomes in both arms can miss uncommon failures, so expand the task set before relying on the result. Retrieval stays opt-in.
