# Backend cache reliability and installation plan

## Objective

Finish cache protocol handling across Leverframe backends, verify multiple-account quota selection and threshold controls, commit all authorized project work, merge to main, push, and install the verified current version on this Mac. Preserve the earlier account, context and managed local inference plans. The urgent cache and account delivery takes priority over local model downloads.

## Invariants

- Keep intentional Claude Code identity and billing line removal for Anthropic API requests. Cache markers and protocol headers are separate concerns.
- Preserve provider, model, billing mode, effort, allowed cache TTL, and credential boundaries. Do not pad prompts, upgrade TTL, change speed tier, or infer quota from token counts.
- Treat missing cache telemetry as unknown, not a measured zero. Keep local estimates separate from measured provider counters and auxiliary summary usage.
- Do not add undocumented cache controls to automatic-cache providers. Verify each actual endpoint and model format, including gateway routes whose model brand differs from the serving provider.
- Never run headless Claude or live model checks. The user explicitly permits existing Caliber calls. Default regression checks use fake upstreams, temporary homes and in-memory credential boundaries.
- Coding uses Terra 6.1 High, independent QA uses Luna Max, and only the trusted test writer changes tests. Parallel production work must use disjoint file ownership and preserve others' changes.
- Run graph impact before existing symbol edits and complete all-change graph analysis before commits. Zero flow coverage requires exact caller analysis and a documented limit, not an unaffected claim.

## Cache protocol work

1. Preserve the Codex request-scoped affinity fix as its own reviewed commit. Extend equivalent handling to the separate inbound OpenAI chat route through that route's own translator. Keep API-key and unrelated provider boundaries intact.
2. Preserve Anthropic API version and beta headers across the routed HTTP adapter. Preserve supported cache markers on system, tool, message and tool-result blocks through the Anthropic SDK and secure Copilot backend. Cover native and translated streaming and nonstreaming paths. Retain intentional scope and identity transformations.
3. Reconcile official caching requirements for Anthropic, OpenAI API and Codex, GitHub Copilot, Kimi/Moonshot, Z.AI, OpenCode gateway models, and other enabled SDK routes. Distinguish automatic caching, explicit controls and unsupported features. Add only documented protocol mappings.
4. Repair compatible-provider cache telemetry where normalization hides absent or vendor-specific counters. Verify raw response boundaries and avoid guessing provider usage or changing wire counts for compatibility without evidence.

## Accounts and verification

1. Audit account plan completion against the actual scheduler, settings and public routes. Verify two-account operation, capacity observations, reset recovery, balancing and failover switches, and no replay after output. Add a clear configurable quota threshold if current controls do not meet the requested proactive threshold behavior. Preserve useful session affinity and unknown-capacity semantics.
2. Run scoped QA after each bounded change and a final review across the cache and account implementation. Test provider bodies and headers, stable identities, aborts, retries, privacy, cache counters, and multi-process account selection with deterministic fake upstreams.

## Integration and installation

1. Review and preserve existing original-checkout native patch work and other authorized pending files before integration. Resolve the known installed-native model schema compatibility failure through the existing patch work. Never erase dirty source or build artifacts with a clean build.
2. Commit bounded changes through intact hooks, merge to main, run final tests, typecheck, lint, build and package checks, then push. Report unresolved checks as failures rather than calling them clean passes.
3. Back up current installed artifacts, build the merged current source in a separate output directory, verify package contents and allowed version commands, then install new dependent chunks before replacing CLI entry points. Both current Node installations link to the original checkout. Preserve active per-session processes and explain that new interactive sessions load new code.
4. Verify the installed version and source revision, provider cache matrix, account settings and final repository state. Actual upstream cache and weekly allowance effects require observations from user-run interactive sessions. Do not claim that offline protocol checks prove provider cache hits or a quota multiplier.

## Evidence and completion

The November 2 merged release passes typecheck, lint and the offline suite with 2,702 tests and eight skips. Independent QA closed the cache and account findings and confirmed that API identity neutralization remains intact. The built package passes installation checks with lifecycle scripts disabled. Both global Node installations on this Mac report 0.5.0. No live model calls established post-fix cache savings. Managed local inference remains separate planned work.

The initial native Codex sample spans 38 matching session files with about 99 percent cached input. Logged Leverframe sol completions show about 52 percent cache reads with different workloads and accounting caveats. The reviewed session header correction addresses a concrete protocol omission, not a proven subscription weighting rule.

Reports live in .superpowers/sdd/codex-subscription-usage. The account and context plan ledgers retain earlier implementation and QA evidence. Final completion requires a requirement-by-requirement check of current source, commits, merged main, push state, installed artifacts and explicit verification limits. Keep the goal active while required work remains.
