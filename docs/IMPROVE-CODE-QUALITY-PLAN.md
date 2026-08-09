# Improve Code Quality Plan

## Context

### Project identity

- Started: 2026-08-09
- Product: Leverframe is a TypeScript Node.js proxy that lets Claude Code use external model providers while preserving its request, tool, and streaming contracts.
- Starting module: Compaction Infrastructure. It is the requested change target and protects the core Claude Code conversation contract.
- Highest failure: corrupting a Claude tool conversation. Michael observed an API stream failure shortly before compaction.
- Stack: TypeScript, Node.js, Vitest, AI SDK, Anthropic-compatible and OpenAI-compatible provider APIs. No ORM or application database is in scope for this pass.

### Evidence

- Existing evidence: `tests/context-control.test.ts` and `tests/request-compaction.test.ts` passed (30 tests) on 2026-08-09.

### Scope facts

- Current implementation risk: ChatGPT OAuth GPT models use static `272000` context-window seeds, which override cache and heuristic lookup. Generic GPT fallback also uses a static heuristic. Provider-reported limits must be characterized before any runtime behavior changes.
- Release context: public repository. Production load and active usage are not yet quantified.
- Dependencies in scope: Anthropic-compatible providers, OpenAI-compatible providers, ChatGPT OAuth, provider model metadata, and Claude Code streaming.
- Agreed scope: Phases 1 through 3, then Phase 7. Phases 4 through 6, 8, 9, and the optional domain phase are deferred.

## Phase Status

| Phase | Skill | Status | Artifact | Date |
|---|---|---|---|---|
| 1: Build the safety net | working-with-legacy-code | awaiting-evidence: stream and live-metadata fixtures absent | TESTING.md + TECH-DEBT.md (GATE) | 2026-08-09 |
| 2: Make the code readable | clean-code | awaiting-evidence: Phase 1 gate remains open | TECH-DEBT.md | 2026-08-09 |
| 3: Apply named refactorings | refactoring-patterns | pending | TECH-DEBT.md | |
| 4: Reduce complexity | software-design-philosophy | deferred: outside agreed scope | TECH-DEBT.md | |
| 5: Draw the architecture boundary | clean-architecture | deferred: outside agreed scope | ARCHITECTURE.md | |
| 6: Lock in the habits | pragmatic-programmer | deferred: outside agreed scope | TECH-DEBT.md | |
| 7: Make it survive production | release-it | pending | RELIABILITY.md | |
| 8: Size for real load | system-design | deferred: load not quantified | ARCHITECTURE.md + RELIABILITY.md | |
| 9: Get the data layer right | ddia-systems | deferred: no data-store change in scope | ARCHITECTURE.md | |
| Optional: Domain language | domain-driven-design | deferred: no domain-language trigger observed | ARCHITECTURE.md | |

Statuses: pending, in-progress, awaiting-evidence, done, deferred: reason, skipped: reason

## Key Decisions

| Date | Phase | Decision | Rationale |
|---|---|---|---|
| 2026-08-09 | 1 | Start with Compaction Infrastructure. | It is the requested change target and a failure can corrupt a Claude tool conversation. |
| 2026-08-09 | 1 | Treat the pre-compaction stream break as a behavior to characterize before fixing. | Tool and stream contracts can have callers that depend on current behavior. |
| 2026-08-09 | 1 | Do not treat static GPT context values as provider truth. | OpenAI OAuth seed values override dynamic lookup, and generic GPT fallback is heuristic. |
| 2026-08-09 | Journey | Complete Phases 1 to 3, then Phase 7. | This covers safety, readability, refactoring, and resilience without starting broader architecture or scaling work. |
| 2026-08-09 | 1 | Pin current context fallbacks before changing them. | The static values are known defects and require a separate behavior change. |
| 2026-08-09 | 2 | Use named budget values and source-aware context conventions. | This removes the local readability smell without changing budget behavior. |

## Next Actions

- [ ] Capture and replay the failing pre-compaction API stream. (Codex, Phase 1 debt, P0)
- [ ] Add an end-to-end compact-request stream fixture with terminal Anthropic SSE events. (Codex, Phase 1 debt, P0)
- [ ] Add live `context_window` and absent-metadata fixtures for the ChatGPT OAuth model refresh path. (Codex, Phase 1 debt, P0)
- [ ] Replace asserted context fallbacks with verified provider metadata or `unconfirmed`. (Codex, Phase 1 debt, P0)
- [ ] Re-enter Phase 2 after the Phase 1 gate closes. (Codex, Phase 2, P0)
