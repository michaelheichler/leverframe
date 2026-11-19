# OpenAI Cache Recovery Implementation Plan

> **For agentic workers:** Use the required sub-skill superpowers:subagent-driven-development or superpowers:executing-plans. Track progress with the checkboxes.

**Goal:** Identify actionable OpenAI cache misses and lower fresh-token usage per successful task.

**Architecture:** Collect paired observations from the current HTTP path, fix demonstrated request changes one at a time, and measure reductions against the existing Preserve prefix control. Track the unresolved stable-prefix observations for upstream investigation.

**Tech Stack:** Leverframe ChatGPT Plan transport, Claude Code interactive sessions, TypeScript, Vitest, and the offline paired evaluator.

**Spec:** [OpenAI cache recovery design](../specs/2026-11-19-openai-cache-recovery-design.md)

## Global Constraints

- Keep the Sign in with ChatGPT HTTP route at `store: false` and `stream: true`, with full input and no `previous_response_id`.
- Collect live samples during ordinary interactive tasks. Use local fixtures for automated checks.
- Preserve missing usage values as unknown and keep them distinct from zero.
- Compare the same provider route, model, credential scope, and effort within each experiment.
- Report weekly allowance from a fresh provider measurement. Keep modeled API dollars separate.
- Keep prompt text, tool schemas, raw session keys, response IDs, and credentials out of diagnostic artifacts.

## Review Focus

- A request can preserve its entire earlier prefix and still receive zero cache reads.
- A recent comparison can point at an older completed request while a newer request is still in flight.
- Model or credential changes establish a new diagnostic scope and can mimic a cold cache.
- Provider diagnostics of `unavailable` leave the cause open even when known usage shows zero reads.
- Higher output and extra turns can consume more allowance even when cache-read share improves.

## File map

| Path | Role |
| --- | --- |
| `docs/backend-caching.md` | Route behavior, diagnostics, and the measured result of each experiment |
| `src/openai-chatgpt-plan-cache-diagnostics.ts` | Reads, prefix comparison, timing, and scope evidence |
| `scripts/cache-session-report.mjs` | Deduplicate local logs, compare cohorts, and prepare redacted support samples |
| `src/openai-chatgpt-plan-append-only-tools.ts` | Candidate fixes for proven tool declarations that rewrite the prefix |
| `src/openai-chatgpt-plan-cache-prefix.ts` | Fixture assertions against the normalized request |
| `tests/openai-chatgpt-plan-prefix-diagnostics.test.ts` and `tests/openai-chatgpt-plan-append-only-tools.test.ts` | Local diagnostics and final-wire regressions |
| `src/compatible-cache-usage.ts` and `tests/compatible-cache-usage-route.test.ts` | Check Go and compatible route counters against upstream fixtures |
| `src/retrieval/evaluation.ts` and `docs/local-retrieval.md` | Existing offline paired evaluator and rollout gate |

Before changing code, run GitNexus upstream impact on the exact symbols. Keep test fixture writes in temporary HOME and LEVERFRAME_HOME. Run the graph change check before any authorized commit.

### Task 1. Establish the current baseline

- [ ] Build the diagnostic patch with `pnpm build`. Run `pnpm exec vitest run tests/openai-chatgpt-plan-prefix-diagnostics.test.ts tests/openai-chatgpt-plan-transport.test.ts tests/openai-chatgpt-plan-append-only-tools.test.ts`. Expect the wire, output redaction, and missing-counter checks to pass.
- [ ] At the next ordinary Home Assistant and Homelab launches, confirm the backend writes `[leverframe openai cache]` after a completed turn. Require the actual model ID and a scope tag. Opt into the upstream comparison for the first Astra trace to capture any returned request IDs. Compare local findings on both sessions.
- [x] Implement offline reporting in `scripts/cache-session-report.mjs`. Deduplicate by model instance and request sequence, then group by model, session, instance, effort, tool mode, and comparison mode. Report prefix outcomes, counter coverage, terminal status, and overlap from observed time intervals.
- [ ] Run `node scripts/cache-session-report.mjs --input <first-log> --input <second-log>` on the new logs. Check that the report keeps the two sessions and their model and effort groups distinct.
- [ ] Keep a redacted example of a recent unchanged prefix with zero reads and one with a positive read. Check that a missing counter remains unknown. Confirm the samples preserve the distinction between local finding and upstream outcome.

### Task 2. Fix proven client-side changes

- [ ] If tool declarations dominate the changed-prefix cases, compare the existing append-only flag with the default using matched Astra tasks and separate sessions. Hold the cache policy, effort, and tool capabilities fixed.
- [ ] Add a final-wire fixture for any remaining documented tool transition that changes an otherwise reusable prefix. Assert deep equality of the previous input slice and original tool order when an addition can append. Assert safe fallback for removals, schema edits, and calls that precede their proposed declaration.
- [ ] With a failing fixture, edit `src/openai-chatgpt-plan-append-only-tools.ts` only for the proven transition. Re-run `pnpm exec vitest run tests/openai-chatgpt-plan-append-only-tools.test.ts tests/retrieval-prefix.test.ts`. Expect both the append and incompatible-transition assertions to pass.
- [ ] If diagnostics instead locate changed instructions, settings, or history, reproduce that section with a redacted fixture before editing its owner. Distinguish compaction and deliberate model or effort changes from avoidable rewrites.

### Task 3. Isolate stable-prefix misses and reduce unnecessary work

- [ ] Compare ordinary sequential Astra requests with existing overlapping traffic at the same model, effort, and credential scope. Use request intervals and baseline age. Report cold or changed scopes separately. Evaluate concurrency limits only if overlap predicts misses after controlling for those factors.
- [ ] For repeatable short-gap stable-prefix misses, use `--support` to prepare a sample with UTC times, model, upstream request IDs when available, cache counts, and local prefix matches. Keep the required HTTP request shape.
- [ ] Run a separate Luna effort comparison only for supported settings and comparable tasks. Measure output, fresh input, turns, and success. Compare context reduction or local retrieval in its own arm so its impact stays identifiable.
- [ ] Write down evidence for or against a same-connection WebSocket pilot. Treat transport continuation and quota benefit as separate questions. Require reconnect, credential isolation, and partial-output recovery fixtures before any future transport rollout.

### Task 4. Verify other routes and evaluate rollout

- [ ] Compare Haiku usage with upstream fixtures that omit cache fields, report explicit zero, and report a positive read. If the route loses this distinction, add the failing fixture before changing the responsible usage parser.
- [ ] Run `pnpm exec vitest run tests/compatible-cache-usage-route.test.ts tests/opencode-go-usage-partition.test.ts`. Expect Go reads, unknown values, and provider allowance to survive translation when the upstream reports them. Keep Opus and DeepSeek's observed strong cache reuse as separate controls.
- [ ] Use `leverframe retrieval evaluate --input <paired-observations.json>` for a comparable task cohort, including retries and failed runs. Require the existing 30-pair pilot gate and verify any weekly allowance claim against fresh observations. For sessions without attributable allowance, report the measured token changes and leave quota impact unknown.
- [ ] Run `pnpm build && pnpm typecheck && LEVERFRAME_SKIP_LIVE_PROVIDER_SMOKE=1 pnpm test && pnpm check:package` for any code proposed for rollout. Document which route and workload earned the rollout.

## Implementation handoff

The recovery tooling runs locally. The user owns fixture checks and interactive verification, including the ordinary tasks that produce diagnostic logs. The existing append-only flag supplies the comparison arm. The saved November 19 logs lack the updated record format, so a default change, a pacing limit, and a Luna effort rollout remain contingent on fresh observations.
