# Technical Debt

## Debt Ledger

| Item | Location | Type | Risk | Effort | Owner | Priority | Status |
|---|---|---|---|---|---|---|---|
| OAuth seed must not assert a context limit. | `src/data/openai-oauth-models.ts` | Behavior | Incorrect Claude Code context display and limit handling. | Medium | Codex | P0 | Implemented, awaiting loopback stream evidence |
| Generic GPT fallback reports `1000000` as a context limit. | `src/context-window.ts` | Behavior | Incorrect context display when metadata is absent. | Medium | Codex | P0 | Open |
| Context budget and request rewrite modules have no production caller. | `src/context/` | Integration | No automatic compaction decision exists. | Large | Codex | P0 | Open |
| Pre-compaction stream break has no captured request or response trace. | Claude Code to provider stream | Evidence | Root cause remains unproven. | Small | Codex | P0 | Awaiting permitted loopback verification or a redacted capture |

## Smell Inventory

| Smell | Location | Refactoring | Owner | Priority | Status |
|---|---|---|---|---|---|
| Semantic array indexes obscure token costs. | `src/context/context-budget.ts` | Replace indexes with named values. | Codex | P1 | Done |
| Hidden context provenance. | OAuth seed and resolver paths. | Introduce source-aware metadata. | Codex | P0 | Implemented, awaiting loopback stream evidence |
| Multi-purpose request rewrite. | `src/context/request-compaction.ts` | Extract validation and rewrite steps. | Codex | P1 | Pending |
| Crowded translation decisions. | `src/sdk-adapter.ts` | Extract named translation decisions. | Codex | P1 | Pending |
| Silent metadata fallback. | Context lookup and cache loading. | Return a provenance-aware lookup result. | Codex | P0 | Pending |

## Sprout / Wrap Register

No sprout or wrap code was added in Phase 1.

## Debt Budget & Broken-Windows Policy

Phase 6 has not set this policy.

## Adopted Conventions

Unknown provider context windows are recorded as unconfirmed. They are not presented as authoritative values.

Context metadata identifies its source as `provider`, `cache`, `heuristic`, `seed`, or `unconfirmed`. Only `provider` is authoritative. Provider metadata errors include provider, model, and source without credentials.

Compaction CI runs focused tests, typecheck, and lint. It does not use a subjective numeric score gate.
