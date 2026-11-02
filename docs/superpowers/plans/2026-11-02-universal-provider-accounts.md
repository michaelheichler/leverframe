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
- Execute inline in this checkout, since the approved work extends its staged integration. Do not commit or install globally.

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

The watcher reports file-size warnings on the existing 611-line refresh coordinator, 543-line patch transform table, and 501-line account-management test file. They remain below its 750-line limit. New account logic lives in separate modules. Extract OAuth model-list parsing from the refresh coordinator, and picker-option construction from the transform table, before further growth reaches that limit.

Independent review found stale refresh publication, missing explicit-account effort metadata, stored catalog parity, and primary-removal cache borrowing. Deterministic regressions cover all four corrections. Additional collision tests preserve generated tags through account mutations.

Final review also found shared anonymous references could transfer catalog ownership or clear the primary catalog during secondary removal. A shared cache resolver now assigns the legacy provider cache only to its logical primary account. Refresh publication and removal use that same ownership rule. Once any catalog exists, Auto excludes accounts without a matching discovered model. Legacy pools without any catalogs retain their previous dispatch behavior.

Final verification passed 2,874 deterministic tests across 358 files, with 8 tests skipped. A subsequent targeted run passed all 10 ownership and legacy dispatch cases, including the additional secondary model mismatch case. Typecheck, lint, build, package verification, and whitespace checks passed. The test command excluded two live Claude conversation suites. Claude maintenance verification used version commands only. Verification made no live inference calls. Independent review reported no remaining concrete findings.

GitNexus change analysis reports 93 tracked files, 254 indexed symbols, and 85 affected processes at critical risk across the combined staged integration and this work. The existing index does not include the new account modules, so those results are incomplete. Focused account regressions and the full deterministic suite cover those modules. The agent made no commit or global install.
