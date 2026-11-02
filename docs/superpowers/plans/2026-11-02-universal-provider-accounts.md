# Universal provider accounts implementation plan

**Goal:** Support named, tagged accounts for every provider, independent account catalogs, explicit account routing, and an Auto pool choice.

**Architecture:** Keep provider IDs and credential references stable. Add account identity to model metadata and routes, discover each account separately, and constrain dispatch when a route names an account. Existing automatic routes retain their identity.

**Stack:** TypeScript, existing provider adapters, Vitest, and the current credential store.

**Spec:** The user approved the design in conversation, including all providers, custom endpoints, names, orange 3 to 4 character tags, and explicit versus automatic account choices.

## Constraints

- Preserve the staged Antigravity integration and existing user credentials.
- Never run headless Claude or live inference.
- Obtain limits from discovery. Keep unavailable limits unknown.
- Keep account IDs stable when names or tags change.
- Delegate test writes to the designated test writer.
- Execute inline in this checkout, since the approved work extends its staged integration. The initial implementation scope excluded commits and installation. The user later authorized release 0.5.1, merges, worktree cleanup, pushing, and installation on the Mac and Tux.

## Review focus

- Selecting an unavailable or deleted account must never fall back to another credential.
- An account catalog must never inherit another account's model limits or entitlement.
- OAuth reauthentication must retain existing accounts and their catalogs.
- Names and tags must survive registry round trips and reject control characters and collisions.
- Auto routes must respect model availability and existing quota controls.

## Tasks

- [x] Add shared account identity helpers, optional registry name/tag/catalog fields, stable automatic tags, and rename support.
- [x] Expose account setup for every configured provider. Choose API, OAuth, or anonymous configuration setup from its authentication metadata.
- [x] Discover and persist account catalogs independently. Preserve primary discovery behavior for existing single-account installations.
- [x] Expand multiple-account catalogs into distinctly tagged account models and explicit Auto pool rows. Carry account IDs through routes, gateway metadata, favorites, aliases, and context refresh.
- [x] Bind dispatch to a selected account without failover, and extend automatic dispatch to supported provider transports without provider-name allowlists.
- [x] Render account tags in Leverframe and Claude Code, with a text fallback. Include account badge metadata in patch hashes.
- [x] Add deterministic regressions before each implementation step, then run typecheck, lint, tests excluding live Claude suites, build, package verification, and graph change analysis.
- [x] Obtain independent review, fix findings, and report verification and any limits.

## Execution notes

The launch coordinator now delegates HTTP launch, model selection, and endpoint launch to focused modules. The account discovery and loading modules isolate the new behavior from the existing discovery coordinator.

The user requested resolution of optional watcher findings. OAuth model parsing now lives in a separate module, leaving the refresh coordinator at 461 lines. Model-option extraction reduces the patch table to 488 lines. Message translation extraction reduces the SDK request coordinator to 352 lines, and account-pool settings tests move to their own file, leaving account management tests at 425 lines. All four reported files fall below the warning threshold.

Independent review found stale refresh publication, missing explicit-account effort metadata, stored catalog parity, and primary-removal cache borrowing. Deterministic regressions cover all four corrections. Additional collision tests preserve generated tags through account mutations.

Final review also found shared anonymous references could transfer catalog ownership or clear the primary catalog during secondary removal. A shared cache resolver now assigns the legacy provider cache only to its logical primary account. Refresh publication and removal use that same ownership rule. Once any catalog exists, Auto excludes accounts without a matching discovered model. Legacy pools without any catalogs retain their previous dispatch behavior.

The implementation passed 2,875 deterministic tests across 358 files, with 8 tests skipped, followed by focused ownership checks. Typecheck, lint, build, package verification, and whitespace checks passed before the release. Verification excluded both live Claude conversation suites and used version commands for Claude maintenance, so it made no live inference calls. Independent review reported no remaining concrete findings at that release point.

The initial GitNexus index omitted new account modules. A full rebuild repaired its FTS inconsistency and indexed the completed release. Compare analysis reported 132 changed files with 866 symbols and 130 affected processes at critical risk across the integrated workstreams.

Release 0.5.1 preserves both workstream histories on main. Both hosts passed native patch diagnostics with matching hashes and no pending transaction. The user approved two push-protection exceptions after exact comparison of bundled OAuth registration constants with their public upstream source. The release push succeeded. The agent removed merged worktrees and feature branches.

Follow-up work records the observed low-credit HTTP 400 as account exhaustion. Auto handles intermediate rejections internally across supported provider transports and reports a counted Leverframe error only after exhausting eligible accounts. Confirmed billing blocks do not receive automatic recovery probes. Context metadata and neutral client instructions retain their existing behavior.

All follow-up checks passed. The suite ran 2,898 tests across 363 files with forced color output and skipped 8 tests. Typecheck and lint passed alongside package verification, and two successive builds produced identical hashes. Focused splits cleared the remaining size warnings. The README includes the provided logo and release badges, with detailed launch settings in a separate guide.
