# Leverframe Stabilization and Selective Clodex Integration Plan

Status: Phases A through F implemented (Phase A and Phase B committed; Phase C, D, E, and F present as uncommitted working-tree changes, including the §21 credential-drift cache fix and the §22 HTTP-proxy routing-decision extraction); Phase G (validate and document) is this document's own closure passes plus the full-suite runs recorded in §18/§20/§21/§22/§24, with §24 the definitive final verification-and-fix pass (one CI-workflow hygiene defect found and fixed, no source/test/dist change needed); deliverable 10 (§16/§16.1/§16.2/§18) verified with a small set of items still genuinely open — see §16.2
Assessment date: 2026-07-29
Leverframe revision: `b5bc3c5e0484e4b546532a2b394930306bfc1c1d`
Clodex revision reviewed: `a857f696b3036ba829764ee7eb2d3f03bc05d375` (v2.1.5)

## 1. Purpose

This document records the repository assessment and implementation plan for three related objectives:

1. Selectively integrate applicable Clodex bug fixes without overwriting Leverframe behavior.
2. Correct repeated false Claude Code patch detection and make patching deterministic and recoverable.
3. Improve provider reliability, error classification, retry safety, and interrupted execution recovery.

This is not a merge plan. Leverframe contains independent provider integrations, configuration behavior, performance work, migration support, and user workflows that must be retained.

## 2. Repository baseline

Leverframe is a Node and TypeScript ESM CLI and local gateway. It uses:

- Node.js 22 or newer
- TypeScript 5.9
- pnpm 10.34.5
- tsup for builds
- Vitest for tests
- AI SDK 7 for translated provider requests
- `undici`, `ws`, and custom HTTP and TLS proxy code
- `tweakcc` 4.3.0 for Claude Code patching

The public entry points are `src/cli.ts` and `src/claude-wrapper.ts`. The package publishes tracked output from `dist/`.

### 2.1 Verification performed during assessment

- `npm run typecheck` passed.
- `npm test` passed all 41 tests.
- `git status --short --branch` reported no working tree changes.
- The build was not run during the read-only assessment because tsup cleans and rewrites tracked `dist/`.

### 2.2 Test and CI regression

At assessment time, only two test files were tracked:

- `tests/patcher.test.ts`
- `tests/patcher-restore.test.ts`

Commit `b8f1f10` removed 82 tests and the CI workflow. Commit `c4ad433` restored source and documentation but did not restore those tests or CI.

At assessment time, `.gitignore` also did not unignore new files under `tests/**` or `.github/**`. Existing test files remained tracked, but newly created test and workflow files could be silently ignored.

Phase A resolved this prerequisite by restoring and adapting the relevant historical suites from revision `091a345`, enabling source and test typechecking, and restoring CI.

## 3. Fork relationship

Leverframe and Clodex have no Git merge base. Leverframe was initialized as a new root commit containing an imported and rebranded source snapshot.

Content comparison identifies the source baseline with high confidence:

| Item | Revision |
| --- | --- |
| Leverframe root | `cf9186dd9013f7f7bccb511b425f2ce6efa75ae4` |
| Clodex source snapshot | `201ac085d70a775fc6095294aaeb41cc1064fda1` |
| Clodex release | v1.0.4 |
| Last runtime change included in that release | `ede161e9ecbb9e11a01c713bdd5ceafd51203ebf` |
| Current Clodex revision assessed | `a857f696b3036ba829764ee7eb2d3f03bc05d375` |

Evidence includes:

- 176 common files.
- 85 files are byte-identical.
- 106 files are exact after normalizing Leverframe and Clodex branding.
- Runtime dependency versions match Clodex v1.0.4.
- Representative source files have 98.7 to 99.8 percent normalized similarity.
- The Leverframe root commit followed the Clodex v1.0.4 release and preceded the next upstream runtime change.

### 3.1 Integration rule

Do not merge unrelated histories. For each upstream fix, use this order of preference:

1. Reimplement the behavior in the current Leverframe architecture.
2. Apply a narrowly scoped diff when production and tests fit cleanly.
3. Port only the relevant hunks and invariants.
4. Reject changes that conflict with intentional Leverframe behavior.

Every implemented fix must record its upstream hash, original issue, upstream files, Leverframe files, port method, tests, and retained Leverframe behavior.

## 4. Claude Code patch lifecycle assessment

### 4.1 Current flow

1. `leverframe claude` discovers a launch target through `src/launch.ts:25-35`.
2. The launch path invokes `runLaunchPatchCheck` through `src/cli.ts:1015-1032`.
3. Patching independently resolves a target in `src/patcher.ts:360-379`.
4. The patch target is canonicalized with `realpath`.
5. The exact target is executed with `--version` in `src/patcher.ts:344-358`.
6. Favorites, aliases, context windows, and provider metadata are canonicalized into `configHash` in `src/patcher.ts:92-147`.
7. One global `patch-state.json` records the binary path, version, configuration hash, patched hash and size, and backup provenance.
8. Startup compares path, version, size, whole-file SHA-256, and configuration in `src/patcher.ts:150-169`.
9. The transaction stages the target, invokes tweakcc, applies Leverframe transforms, and validates markers and hashes in `src/patcher.ts:465-518`.
10. The backup, live binary, and manifest are replaced as separate operations in `src/patcher.ts:519-530`.

Commit `b5bc3c5` must be preserved. It correctly treats an unmarked, refreshed Claude binary as the new authoritative baseline instead of restoring a stale same-version backup. It also added exact-path version probing, baseline hashes, patch markers, and staged validation.

### 4.2 Confirmed design defects

#### 4.2.1 Launch and patch can select different installations

Launch discovery honors `LEVERFRAME_CLAUDE_PATH` and a saved launch override before platform fallbacks.

Patch discovery uses this order:

1. `TWEAKCC_CC_INSTALLATION_PATH`
2. `~/.local/bin/claude`
3. Normal launch discovery

A workstation with native, Homebrew, npm, or custom installations can patch one target and launch another. This is a strong explanation for behavior that differs between two machines.

#### 4.2.2 Missing state creates a permanent warning loop

Startup classifies a missing or path-mismatched manifest as `unpatched` in `src/patcher.ts:150-169`.

The patch transaction later recognizes Leverframe markers in `src/patcher.ts:233-279` and refuses to patch an injected target without trusted state in `src/patcher.ts:316-323`.

The resulting loop is deterministic:

1. Startup says the installation needs patching.
2. Patching detects an already injected target and refuses to continue.
3. State is not reconstructed.
4. The next startup emits the same warning.

Possible triggers include a changed `LEVERFRAME_HOME`, a missing or corrupt manifest, stale absolute paths copied from legacy state, a pre-`b5bc3c5` manifest, or an interrupted manifest publication.

#### 4.2.3 State is not installation-specific

Leverframe stores one global manifest. Backups are named only by Claude version. Two same-version installations can overwrite each other's manifest ownership and pristine baseline.

#### 4.2.4 Whole-file SHA checks are too coarse

A code-sign operation, repack, standalone tweakcc invocation, or another legitimate modifier can change the target bytes while every Leverframe patch site remains valid.

The current state check cannot distinguish:

- A valid patch with unrelated metadata changes
- A compatible external modification
- A damaged or partial patch
- A genuine Claude update
- A manual modification

#### 4.2.5 The transaction is not crash-consistent

The pristine backup, live binary, and manifest are committed separately. An interruption can leave:

- A patched binary with no manifest
- A restored binary with a stale manifest
- A new backup with an old live binary
- A successful binary replacement reported as failed

There is no write-ahead transaction journal, rollback path, or startup reconciliation.

#### 4.2.6 Pre-`b5bc3c5` state is not migrated

Older manifests do not contain `baselineSha256` and can reference tweakcc-owned backups. Current code detects that the binary is injected, then refuses to adopt or migrate the old state.

#### 4.2.7 Additional patch risks

- `stagingPath` uses the destination grandparent rather than the destination directory in `src/patcher.ts:387-389`.
- The patch lock can evict a live owner based only on age in `src/patcher.ts:172-226`.
- The original lock owner can later remove a successor's lock.
- macOS repacking relies on tweakcc ad-hoc signing, but Leverframe does not execute or verify the staged candidate before committing it.
- Logical path, canonical path, tweakcc installation path, and final spawn target are not compared as one installation identity.
- Current diagnostics omit resolver source, installation kind, semantic patch state, manifest validation details, and the underlying inspection failure.

## 5. Target patch architecture

### 5.1 Unified installation identity

Add `src/claude-installation.ts` with one resolver that returns:

```ts
interface ClaudeInstallation {
  logicalPath: string;
  canonicalPath: string;
  installationPath: string;
  discoverySource: string;
  installationKind: string;
  version: string;
  executableType: string;
}
```

The same resolved object must be used for startup verification, patching, restore, and final launch.

Resolution must honor explicit overrides before native and package-manager fallbacks. `which` or `where` results must be verified before use.

### 5.2 Per-target state

Replace the global manifest with state keyed by canonical target identity:

```text
$LEVERFRAME_HOME/state/patches/<canonical-target-hash>/
  manifest.json
  transaction.json
  lock
  baselines/
    claude-<version>-<baseline-sha256>.orig
```

The manifest should contain:

- Schema version
- Patch transform version
- Logical and canonical paths
- Installation kind
- Claude version
- Baseline SHA-256
- Patched SHA-256
- Semantic patch fingerprint
- Configuration hash
- Backup path and provenance
- Transaction generation
- Completion timestamp

### 5.3 Explicit states

The patch inspection result should distinguish:

- `unpatched`
- `patched`
- `config_stale`
- `updated`
- `modified`
- `modified_but_injected`
- `partially_patched`
- `state_missing`
- `unsupported`

A marker-bearing target must never be reported as simply unpatched.

### 5.4 Semantic verification

Use both exact hashes and structural verification:

- Whole-file SHA-256 identifies exact known generations.
- Versioned patch markers identify Leverframe ownership.
- Required patch sites confirm semantic completeness.
- Optional patch sites report compatibility details.
- Configuration and transform versions determine whether repatching is needed.

A whole-file mismatch with valid markers and patch sites should become `modified_but_injected`, not `unpatched` or a generic stale state.

### 5.5 Crash-safe transaction

Add a write-ahead journal with phases such as:

1. `prepared`
2. `baseline_committed`
3. `binary_committed`
4. `manifest_committed`
5. `completed`

Each phase must be written atomically before the next destructive operation. On startup, Leverframe must inspect hashes and either complete the transaction or restore the last verified state.

Staging should occur in the destination directory so the final rename remains on one filesystem.

### 5.6 Diagnostics

Add:

```text
leverframe patch --diagnose
leverframe patch --diagnose --json
leverframe patch --target <path>
```

Diagnostics should report:

- Logical and canonical paths
- Discovery source and installation kind
- Claude version
- Leverframe patch and schema versions
- Manifest and backup locations
- Expected and observed hashes
- Marker and patch-site results
- Transaction phase
- Exact state classification
- Exact failed verification condition

Diagnostics must not expose target file contents, credentials, authorization headers, or private prompts.

## 6. Provider architecture assessment

### 6.1 Current transport paths

Leverframe has three distinct provider paths:

1. Native Anthropic passthrough using raw Node HTTP streams.
2. AI SDK translation for non-Anthropic providers.
3. A custom OpenAI Responses WebSocket transport for ChatGPT and Codex OAuth.

Native Anthropic passthrough should remain outside the AI SDK. Golden tests should preserve its request headers, body, response status, error body, and SSE behavior.

### 6.2 Primary Codex timeout defect

`src/oauth/responses-websocket.ts` creates a synthetic HTTP 200 response before the WebSocket handshake succeeds.

The `unexpected-response` handler in `src/oauth/responses-websocket.ts:1041-1050` logs a rejected upgrade but does not consume and terminate the response. Registering this handler also suppresses the default `ws` abort path.

The request can remain alive until Leverframe's idle timeout. Authentication failures, 429 responses, provider 5xx responses, and proxy upgrade failures can therefore appear as generic timeouts.

Additional relevant locations:

- Synthetic response creation in `src/oauth/responses-websocket.ts:1100-1115`
- Message-only stream error conversion in `src/oauth/responses-websocket.ts:799-815`

### 6.3 Other reliability gaps

- Endpoint mode does not abort provider work when the client disconnects.
- SSE writers do not wait for backpressure.
- Raw forwarding lacks separate connection, header, idle, and total deadlines.
- OpenAI adapter requests lack explicit deadline handling.
- Cached provider clients can retain expired OAuth credentials.
- Translated requests do not consistently refresh once after a rejected token.
- Retry limits are inherited implicitly from AI SDK defaults.
- Stream and non-stream finish-reason mappings differ.
- Some incomplete responses can be reported as successful `end_turn` responses.
- HTTP status, provider request ID, retryability, and failure phase are frequently lost.
- WebSocket continuation state is process-local and disappears on restart.
- Shutdown does not consistently abort active work or close provider handles.
- No provider-neutral execution checkpoint exists.

### 6.4 Tool safety boundary

Leverframe does not execute tools. Claude Code or another client performs tool execution and sends results in a later request.

Leverframe can safely track:

- Provider-issued tool-call IDs
- Tool calls emitted to a client
- Tool results received later from the client
- Whether a retry might emit a duplicate call

Leverframe cannot prove that an external client persisted state before executing a tool. Unknown client-side execution status must therefore be treated as ambiguous. Automatic replay must stop after a potentially state-changing tool call is emitted.

Translated tool semantics also need correction:

- `tool_choice: none` can be lost.
- Parallel-tool restrictions can be lost.
- Tool schema `strict` can be lost.
- `tool_result.is_error` is ignored.
- Top-level `null` and empty-array arguments can be removed.
- Tool lists can be silently truncated.

## 7. Target provider reliability architecture

### 7.1 Error taxonomy

Add `src/provider-error.ts` with provider-neutral classifications:

- Connection establishment failure
- DNS failure
- TLS failure
- Proxy failure
- Header timeout
- Idle timeout
- Overall deadline exceeded
- Remote stream closed unexpectedly
- Malformed stream event
- Provider cancellation
- Local cancellation
- Rate limited
- Authentication failure
- Permission failure
- Provider server error
- Context-length failure
- Invalid request
- Tool-call protocol failure
- Tool-result submission failure
- Child-process crash
- Unknown transport failure

Each error should preserve:

- Provider and model
- Request phase
- HTTP status
- Provider request ID
- OS error code and cause
- Retryability
- `Retry-After`
- Whether any output was emitted
- A safe user-facing message
- Redacted diagnostic details

### 7.2 Request lifecycle

Add `src/request-lifecycle.ts` with states:

```text
accepted
validated
dispatched
first_output
terminal
```

The lifecycle should own:

- Request and correlation IDs
- Linked cancellation
- Connection deadline
- Header deadline
- Stream idle deadline
- Total request deadline
- Retry attempt records
- First-output tracking
- Backpressure-aware output
- Final-response validation
- Structured terminal outcome

Automatic replay is allowed only before visible output or tool-call emission.

### 7.3 Provider capability matrix

Add `src/provider-capabilities.ts` and expose capabilities through `src/provider-factory.ts`:

- Native conversation continuation
- Native response continuation
- Idempotency keys
- Request status lookup
- Stable tool-call identifiers
- Streaming
- Server-side conversation state
- Client-managed conversation state
- Credential and connection rotation

Recovery code must use declared capabilities rather than infer support from provider names.

### 7.4 OAuth client generations

Cached provider handles must include a credential generation or credential fingerprint in their identity.

After a rejected access token:

1. Refresh once through the existing single-flight refresh mechanism.
2. Persist the new credential atomically.
3. Close and evict provider and WebSocket handles created with the old credential.
4. Rebuild the handle.
5. Replay only if no output has been emitted.
6. Preserve and report refresh errors if recovery fails.

### 7.5 WebSocket handling

Refactor the OpenAI Responses transport into an owned handle with explicit `fetch` and `close` operations.

A rejected upgrade must:

- Consume and terminate the rejected response.
- Preserve HTTP status and relevant safe headers.
- Preserve provider request ID.
- Classify retryability.
- Honor `Retry-After`.
- Fail before returning a synthetic successful response.

Retain the existing invariant that continuation state is committed only after a confirmed completion event.

## 8. Provider-neutral checkpoints

### 8.1 Storage layout

Add:

- `src/checkpoint-store.ts`
- `src/execution-checkpoint.ts`
- `src/execution-recovery.ts`
- `src/tool-call-ledger.ts`

Store checkpoints under:

```text
$LEVERFRAME_HOME/state/executions/<workspace-hash>/<execution-id>/
  checkpoint.json
```

Directories should use mode 0700 and files should use mode 0600.

### 8.2 Checkpoint schema

Persist only visible and supported state:

- Schema version and generation
- Leverframe session and request IDs
- Provider and model
- Client-managed conversation fingerprint
- Provider conversation or response IDs when available
- Normalized visible message history
- Completed assistant text and output chunks
- Pending tool calls
- Completed tool-call IDs and received results
- Last confirmed provider event
- Retry count
- Failure classification
- Recovery decision
- Creation, update, and expiry timestamps

Never persist:

- API keys
- Authorization headers
- Proxy credentials
- Hidden chain-of-thought
- Unsupported provider-internal reasoning
- Unredacted diagnostic bodies

### 8.3 Recovery decisions

Recovery must classify an interrupted execution as one of:

1. Native provider resume.
2. New request using preserved conversation state.
3. Safe replay before first visible output.
4. Continuation from preserved partial text.
5. Confirmation required because tool execution status is ambiguous.
6. Unrecoverable with a precise explanation.

A reconstructed continuation must be described as reconstruction, not transport-level resume.

## 9. Upstream commit disposition

The range from Clodex v1.0.4 to v2.1.5 contains 50 commits. All 25 runtime fixes and five relevant features were assessed.

### 9.1 Low-coupling fixes to port first

| Commit | Original issue | Upstream files | Leverframe disposition |
| --- | --- | --- | --- |
| `94aeab8` | Fresh native installs can resolve a broken transitive native dependency | `package.json`, lockfile | Port the dependency pin directly |
| `b770db6` (#9) | WebSocket connections can be reused across credentials | `src/oauth/responses-websocket.ts`, `src/provider-factory.ts`, tests | Port with credential-partition tests |
| `904b077` (#11) | Rejected WebSocket upgrades do not terminate | `src/oauth/responses-websocket.ts`, `src/sdk-adapter.ts`, tests | Port first because it addresses false timeouts |
| `8485e1c` (#29) | Transient pre-frame WebSocket failures are not retried | `src/oauth/responses-websocket.ts`, tests | Port after `904b077` with one bounded retry |
| `ac48a3b` (#22) | Tool-result images become oversized base64 text | `src/anthropic-endpoints.ts`, `src/sdk-adapter.ts`, tests | Port with image and usage tests |
| `4d96f54` (#56) | Cached input usage is counted twice | `src/sdk-adapter.ts`, tests | Port with stream and non-stream usage tests |

### 9.2 Fixes to adapt manually

| Commit | Original issue | Main upstream areas | Adaptation reason |
| --- | --- | --- | --- |
| `303db6e` (#33) | Bodyless WebSocket 403 throttles need retryable 429 semantics | WebSocket, proxy, router, error mapping | Depends on typed upgrade errors and retry context |
| `32c1f7b` (#38) | WebSocket connection limits need retry semantics | WebSocket | Depends on the preceding retry stack |
| `f9272d6` (#16) | Rejected access tokens need one forced refresh | OAuth, catalog, router, registry | Must use Leverframe credential storage |
| `77ae2bf` (#23) | Listener readiness can be reported too early | Proxy, router, listener helper | Clodex callback server is absent locally |
| `383f464` (#10) | Configured routes can bypass to another provider | Catalog, proxy, HTTP proxy, environment | Must retain dynamic Leverframe routes |
| `6de7af9` (#54) | Private adapter connections are not reused | HTTP proxy, proxy | Add keep-alive without changing native passthrough |
| `5fec19a` (#59) | Alias canonicalization has unsafe fallback behavior | Aliases, routes, proxy, patcher | Must retain supplier-derived aliases and models |
| `d4ec9e2` (#21) | Anonymous routes can receive synthetic credentials | Auth headers, provider factory, proxy, router | Adapt to Leverframe keyring behavior |
| `9657038` (#15) | Credential cleanup can be interrupted | Registry and credential lifecycle | Needs a Leverframe-specific journal |
| `102e496` (#39) | Interactive mutations miss credential reconciliation | Provider command | Depends on cleanup journaling |
| `cae6db6` (#17) | Chunked keyring credentials can become mixed or partial | Credential helpers and keyring | Adapt to `src/credential-store.ts` |
| `46d4818` (#35) | Resolved secrets can leak in trace logs | Custom endpoint and trace logging | Add structural and value-based redaction |
| `73661d6` (#51) | Wrapper child prevents PTY resize propagation | `src/claude-wrapper.ts`, tests | Use process replacement while retaining the import guard |
| `5bff8dd` (#43) | Proxy transport failures lack attribution | Proxy, HTTP proxy, trace and error types | Integrate into the shared taxonomy |
| `09f79ad` (#60) | Transform changes are ignored when model config is unchanged | Patcher and transforms | Include transform version in patch identity |
| `e61f972` (#57) | Patched clients lose extended effort levels | Patcher, transforms, provider factory | Integrate with supplier-derived capabilities |
| `164be9d` (#62) | Version and backup provenance can refer to the wrong binary | Launch, patcher, backup module | Retain local transaction work and port provenance rules |

### 9.3 Already implemented differently

| Commit | Disposition |
| --- | --- |
| `e653d89` (#40) | Serialized atomic preference writes already exist in `src/config.ts`. Optional file and directory sync can still be added. |

### 9.4 Not applicable without an optional feature

| Commit | Disposition |
| --- | --- |
| `de233d8` (#44) | Listener retry behavior applies only if strict managed-wrapper readiness is adopted. |

### 9.5 Features to use as design references

| Commit | Disposition |
| --- | --- |
| `502450c` (#8) | Use its credential and registry hardening patterns without importing its architecture wholesale. |
| `e590981` (#12) | Defer strict wrapper readiness unless Leverframe adopts that workflow. |
| `495684c` (#30) | Consider process lifecycle logging after correctness work. |
| `2de8cf8` (#26) | Use response correlation concepts in the shared lifecycle design. |

### 9.6 Intentionally rejected

| Commit | Disposition |
| --- | --- |
| `6a7b5cf` (#37) | Reject removal of legacy relay-ai migration. Leverframe intentionally preserves Clodex and relay-ai state and credential migration. |

### 9.7 Relevant fixes already present in the fork baseline

- `bfb626f`, pinned programmatic tweakcc API.
- `105dde5`, optional tool-parameter filler handling.
- `ede161e`, keepalive while buffering streamed tool-call arguments.

The tool-parameter sanitizer from `105dde5` should be narrowed because removing legitimate `null` and empty-array values can change tool semantics.

## 10. Implementation phases

### Phase A: Restore the quality floor

Files:

- `.gitignore`
- `.github/workflows/**`
- `tests/tsconfig.json`
- `package.json`
- Selected tests recovered from revision `091a345`

Work:

1. Unignore test and workflow paths.
2. Restore relevant historical test suites.
3. Add source and test typechecking.
4. Enforce the pinned pnpm version through Corepack.
5. Restore CI checks for install, typecheck, test, build, package contents, and tracked `dist` consistency.

### Phase B: Port low-coupling upstream fixes

Files:

- `package.json`
- `pnpm-lock.yaml`
- `src/oauth/responses-websocket.ts`
- `src/provider-factory.ts`
- `src/sdk-adapter.ts`
- `src/anthropic-endpoints.ts`
- Restored focused tests

Port the WebSocket fixes in dependency order. Preserve provider status, request IDs, `Retry-After`, retryability, and output-emission state.

### Phase C: Implement deterministic patch identity and recovery

Files:

- `src/binary-lookup.ts`
- `src/launch.ts`
- `src/patcher.ts`
- `src/patch-transforms.ts`
- `src/cli.ts`
- New patch identity, state, diagnostics, lock, and atomic-write modules
- Patch test suites and fixtures

Retain the refreshed-baseline behavior from `b5bc3c5`.

### Phase D: Implement provider lifecycle and error taxonomy

Files:

- New `src/provider-error.ts`
- New `src/request-lifecycle.ts`
- New `src/provider-capabilities.ts`
- `src/upstream-error.ts`
- `src/sdk-adapter.ts`
- `src/openai-adapter.ts`
- `src/proxy.ts`
- `src/server/router.ts`
- `src/upstream-forward.ts`
- `src/oauth/responses-websocket.ts`
- `src/trace-log.ts`

Keep native Anthropic passthrough on raw Node streams and protect it with golden tests.

### Phase E: Implement checkpoint and recovery policy

Files:

- New `src/checkpoint-store.ts`
- New `src/execution-checkpoint.ts`
- New `src/execution-recovery.ts`
- New `src/tool-call-ledger.ts`
- Integration in proxy, router, adapters, and provider factory

### Phase F: Port remaining safety fixes

Port routing, credential, wrapper, connection reuse, and logging fixes only after the shared persistence and lifecycle primitives exist.

### Phase G: Validate and document

Run all automated checks, fixture installations, provider failure simulations, CLI smoke tests, and package-content checks. Update README usage only when new CLI diagnostics or recovery behavior is implemented.

## 11. Test plan

### 11.1 Patch lifecycle

Tests must use temporary fixture installations rather than a real Claude installation.

Required cases:

- First patch
- Second startup without changes
- Repeated patch invocation
- Claude version update
- Modified target file
- Marker present with missing state
- Corrupt or unsupported manifest
- Pre-`b5bc3c5` state migration
- Interrupted transaction at every commit phase
- Two same-version installations
- Different canonical paths
- Symlinked target
- Retargeted symlink
- Native, Homebrew, npm, and custom layouts
- macOS `/var` canonicalization behavior
- Executable mode preservation
- Signature verification failure
- Restore, rollback, and restart reconciliation
- Live lock owner beyond the stale threshold
- Ownership-safe lock release

### 11.2 Provider failure simulation

Use local fake HTTP, HTTPS, and WebSocket providers.

Required cases:

- Connection refusal
- Delayed connection
- DNS failure
- TLS failure
- Proxy failure
- Delayed headers
- Idle stream
- Truncated SSE
- Malformed SSE
- Rejected WebSocket upgrade
- HTTP 429 with `Retry-After`
- HTTP 500, 502, 503, 504, and 529
- Authentication failure
- Successful and failed token refresh
- Stream termination before first output
- Stream termination after partial text
- Stream termination during tool-call generation
- Duplicate tool-call ID after retry
- Tool result received after reconnect
- Slow-client backpressure
- Client disconnect
- Graceful and forced shutdown
- Successful native resume
- Successful reconstructed continuation
- Checkpoint restart at every phase
- Confirmation requirement after ambiguous tool execution

### 11.3 Native Anthropic preservation

Golden tests should compare:

- Request method, URL, headers, and body
- Duplicate and ordered header behavior where relevant
- Response status and headers
- Error bodies
- SSE event ordering
- Cancellation behavior
- Model ID echo behavior
- Prompt-cache and beta headers

## 12. Manual diagnostics for the affected MacBook

Do not reset patch state before collecting diagnostics.

The diagnostic command should collect:

- All resolved `claude` commands on PATH
- Logical and canonical path for every installation
- Installation method where detectable
- Exact version for each installation
- Presence and target of `~/.local/bin/claude`
- Relevant Leverframe and tweakcc path overrides
- Leverframe home path
- Patch manifest status and target identity
- Expected and observed hashes
- Marker and semantic patch-site state
- Backup identity and provenance
- Pending transaction state

Until `leverframe patch --diagnose` exists, useful manual facts include:

```bash
command -v -a claude
claude --version
```

Also inspect whether these environment variables are set:

- `LEVERFRAME_CLAUDE_PATH`
- `TWEAKCC_CC_INSTALLATION_PATH`
- `LEVERFRAME_HOME`

Do not publish target contents, credentials, private prompts, or unredacted state files in issue reports.

## 13. Migration guidance

Migration should be automatic and conservative:

1. Detect legacy manifest schema.
2. Confirm the canonical live target matches the legacy target.
3. Confirm the legacy patched SHA matches the live target.
4. Locate the legacy backup.
5. Confirm the backup has the same Claude version and no Leverframe injection markers.
6. Copy the backup into per-target content-addressed storage.
7. Publish the new manifest atomically.
8. Preserve the legacy state until the new state is verified.

If any positive verification fails, stop with a diagnostic. Do not adopt an unknown target as pristine.

No blanket state-reset instruction should be provided. Recovery depends on whether the installation is updated, externally modified, partially patched, or only missing metadata.

## 14. Rollback strategy

Each implementation phase should remain independently reversible.

### Patch changes

- Preserve immutable pristine baselines.
- Never delete legacy state during migration until the new manifest is verified.
- Journal every destructive operation.
- Support rollback to the verified baseline when manifest publication fails.
- Keep a schema reader for the previous manifest version during one migration window.

### Provider changes

- Keep native Anthropic passthrough unchanged.
- Introduce lifecycle and checkpoint behavior behind internal capability checks.
- Make retry policy explicit and bounded.
- Permit checkpoint recovery to be disabled without disabling normal requests.
- Preserve old error causes inside the new taxonomy.

### Upstream ports

- Port one dependency group at a time.
- Keep upstream attribution in the change documentation.
- Run focused regression tests after each group.
- Revert the individual port if it changes Leverframe-specific routes, credentials, migration, or provider metadata unexpectedly.

## 15. Validation commands

Use the pinned package manager:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --exit-code dist
npm pack --dry-run
```

Additional validation must include:

- Patch fixture smoke tests
- Provider HTTP and WebSocket failure simulations
- Checkpoint restart tests
- Test typechecking
- CLI help and diagnostic smoke tests
- Secret sentinel tests for logs and checkpoints
- Final working tree review for generated files, credentials, and local machine paths

## 16. Completion records

For every imported or adapted upstream change, append a row when implementation occurs:

| Upstream commit | Original issue | Upstream files | Leverframe files | Method | Tests | Retained Leverframe behavior |
| --- | --- | --- | --- | --- | --- | --- |
| `94aeab8` | Fresh installs could miss `node-gyp-build` required by a broken transitive `node-lief` release | `package.json`, `pnpm-lock.yaml` | `package.json`, `pnpm-lock.yaml` | Narrow dependency port | Frozen install and root resolution checks | Exact dependency versions and tweakcc 4.3.0 retained |
| `b770db6` (#9) | WebSocket reuse could cross credentials | `src/oauth/responses-websocket.ts`, `src/provider-factory.ts`, tests | `src/oauth/responses-websocket.ts`, `src/provider-factory.ts`, `src/server/router.ts`, provider, router, and WebSocket tests | Adapted with non-secret SHA-256 partitioning and stale idle-handle eviction | Credential rotation, fallback account ID, concurrent credentials, server handle rebuild, and redaction tests | Existing keyring, supplier metadata, account fallback, and connection lineage retained |
| `904b077` (#11) | Rejected WebSocket upgrades could hang until an idle timeout | `src/oauth/responses-websocket.ts`, `src/sdk-adapter.ts`, tests | `src/provider-error.ts`, `src/oauth/responses-websocket.ts`, `src/sdk-adapter.ts`, `src/openai-adapter.ts`, `src/upstream-error.ts`, `src/proxy.ts`, `src/server/router.ts`, tests | Adapted with a typed transport error, deferred handshake completion, and a bounded opening-handshake timeout | Local-server tests for 401, 403, 407, 429, 500, 502, 503, 504, 529, request IDs, response bodies, stalled and immediate-close handshakes, error propagation, and cancellation | Native Anthropic raw forwarding and Leverframe diagnostics retained |
| `8485e1c` (#29) | Transient pre-frame WebSocket failures were not retried | `src/oauth/responses-websocket.ts`, tests | `src/oauth/responses-websocket.ts`, `src/sdk-adapter.ts`, retry integration and unit tests | Adapted with one explicit retry, jittered backoff, `Retry-After`, cancellation, and SDK retry disablement for OAuth | Recovery, exact retry limit, 429, 503, 401, 403, partial output, tool call, cancellation, shutdown, and budget tests | Completed-only continuation commits and client-owned tool execution retained |
| `ac48a3b` (#22) | Tool-result images became oversized base64 text | `src/anthropic-endpoints.ts`, `src/sdk-adapter.ts`, tests | `src/anthropic-endpoints.ts`, `src/provider-error.ts`, `src/sdk-adapter.ts`, `src/upstream-error.ts`, proxy, adapter, server, and native passthrough tests | Source port plus strict translated image validation and terminal HTTP 400 classification | Mixed text and image, malformed base64, unsupported media type, large payload, token estimate, route classification, and raw passthrough tests | Native Anthropic request bytes remain untouched |
| `4d96f54` (#56) | Cached input usage could be counted twice | `src/sdk-adapter.ts`, tests | `src/sdk-adapter.ts`, adapter and proxy tests | Source port plus malformed and separate-field normalization | Stream and non-stream uncached, read, write, fully cached, separate cache, missing, legacy, and malformed usage tests | Native Anthropic usage forwarding remains untouched |
| `f9272d6` (#16) | Rejected access tokens need one forced refresh | OAuth, catalog, router, registry | `src/env.ts`, `src/oauth/refresh.ts`, `src/credential-store.ts`, tests | Adapted with a `rejectedAccessToken` pass-through, an in-flight refresh dedup keyed by account and rejected value, and a persisted `accessRejected` CAS-style marker so a repeat-rejected refresh is not retried forever | `tests/refresh-credentials.test.ts`, `tests/oauth.test.ts` cover forced refresh, single retry, dedup, and persistence of the rejection marker | Existing keyring storage and non-native OAuth passthrough retained |
| `d4ec9e2` (#21) | Anonymous routes can receive synthetic credentials | Auth headers, provider factory, proxy, router | `src/provider-factory.ts`, `src/proxy.ts`, `src/server/router.ts`, `src/env.ts`, tests | Adapted to Leverframe's `none:anonymous` authRef convention: anonymous routes never fabricate a bearer value | `tests/provider-factory.test.ts`, `tests/proxy.test.ts`, `tests/server-router.test.ts` | Existing anonymous free-model routing retained |
| `9657038` (#15) | Credential cleanup can be interrupted | Registry and credential lifecycle | New `src/registry/credential-cleanup-journal.ts`, `src/registry/credential-lifecycle.ts`, `src/registry/lock.ts` | Leverframe-specific schemaVersion-1 cleanup journal: validated, deduped, bounded managed refs; durable publication via `durableAtomicWrite`; queue-before-orphan, commit-under-registry-lock, reconcile-outside-lock-under-per-ref-lock, strict re-read before delete, cancel-if-active-again, retain-uncertain-failures, warn-once | `tests/credential-lifecycle.test.ts`, `tests/credential-durability.test.ts`, `tests/registry-durability.test.ts` cover restart-safety, concurrency, corruption, and idempotent reconciliation | Existing registry CRUD and provider template flows retained |
| `102e496` (#39) | Interactive mutations miss credential reconciliation | Provider command | `src/registry/add-template.ts`, `src/registry/crud.ts`, `src/providers-command.ts` | Every direct and interactive registry mutation now calls `reconcilePendingCredentialDeletes` in a `finally` block after releasing the mutation lock | `tests/providers-command.test.ts`, `tests/credential-lifecycle.test.ts` | Existing interactive prompts and CLI output retained |
| `cae6db6` (#17) | Chunked keyring credentials can become mixed or partial | Credential helpers and keyring | `src/credential-store.ts` | Generational v3 chunk marker (generation, count, SHA-256), generation-scoped chunk keys, per-account locks, publish-before-retire, legacy-format readability and migration, fail-closed on tampered or missing state, restart-safe deletion guards with tombstones and inventory reconciliation | `tests/credential-store.test.ts`, `tests/credential-durability.test.ts` cover chunking, digest mismatch, legacy migration, symlink/mode hardening, reactivation, and idempotent deletion | Isolated child process, Leverframe service, and clodex/relay-ai read-only migration paths retained; 0600 fallback retained |
| `502450c` (#8) | Credential and registry hardening design reference | N/A (design reference only) | `src/registry/lock.ts`, `src/durable-io.ts`, `src/atomic-file.ts` | Used only as a pattern reference for cross-process registry locking and durable-write primitives; no upstream architecture imported wholesale | `tests/registry-lock.test.ts`, `tests/registry-lock-worker.test.ts`, `tests/atomic-file.test.ts`, `tests/config-lock-contention.test.ts` | Leverframe's own registry schema and CLI surface retained |
| `e653d89` (#40) | Serialized atomic preference writes already exist in `src/config.ts` | N/A | `src/atomic-file.ts`, `src/durable-io.ts`, `src/config.ts` | Extended with unique 0600 temp file, fsync, rename, and parent-directory fsync for both file and directory durability | `tests/atomic-file.test.ts`, `tests/config.test.ts`, `tests/config-lock-failure.test.ts`, `tests/config-lock-contention.test.ts`, `tests/config-lock-contention-worker.test.ts` | Existing config schema and CLI behavior retained |
| `105dde5` | Tool-parameter filler removal could change tool semantics for legitimate `null`/empty-array values | N/A (already present in fork baseline) | `src/sdk-adapter.ts` | Narrowed from a blanket filler-value stripper to a per-tool, per-parameter allowlist (`WebSearch: allowed_domains, blocked_domains`) so only known server-side-tool filler is dropped; every other tool's `null`/`[]` argument values pass through unchanged | `tests/sdk-adapter.test.ts` | Ordinary tool schemas that intentionally send `null` or `[]` retain those values |
| `46d4818` (#35) | Resolved secrets can leak in trace logs | Custom endpoint and trace logging | `src/trace-log.ts` | Adapted with layered redaction: literal-value pass (any resolved secret string ≥8 chars is matched verbatim and replaced) plus structural pattern passes (`Authorization`, `x-api-key`, bearer tokens, JWT-shaped strings, and provider key prefixes: `sk-`, `sk-ant-`, `sk-or-`, `xai-`, `hf_`, `AIza`, `gsk_`) | `tests/trace-log.test.ts` | Existing debug-log format and opt-in logging retained |
| `73661d6` (#51) | Wrapper child prevents PTY resize propagation | `src/claude-wrapper.ts`, tests | `src/claude-wrapper.ts` | Adapted with `process.execve` process replacement (same PID/PGID, direct PTY passthrough) guarded by an availability check, with a spawned-child fallback path preserved for Windows and runtimes without `execve` | `tests/claude-wrapper.test.ts`, `tests/wrapper-env.test.ts` | Existing import-guard and non-POSIX fallback behavior retained |
| `09f79ad` (#60) | Transform changes are ignored when model config is unchanged | Patcher and transforms | `src/patch-classify.ts`, `src/patch-state.ts`, `src/patch-reconcile.ts`, `src/patch-diagnostics.ts` | Adapted by adding a `transformVersion` field to the persisted manifest and journal; `config_stale` classification now fires on a `configHash` OR `transformVersion` mismatch against `currentTransformVersion()` | `tests/patch-v2.test.ts`, `tests/patcher.test.ts` | Existing configHash-only staleness path still covered; V1 manifests without the field are treated as stale rather than crashing |
| `e61f972` (#57) | Patched clients lose extended effort levels | Patcher, transforms, provider factory | `src/provider-factory.ts`, `src/reasoning-capabilities.ts` | Adapted as supplier-authoritative capability wiring (not a literal port): reasoning levels are derived per-provider from `ReasoningMetadata`/`getReasoningCapabilities` rather than hard-coded, covering OpenAI (`low/medium/high/xhigh`), xAI (`none/low/medium/high`), OpenRouter (`none/minimal/low/medium/high/xhigh`), DeepSeek V4 (`high/max/off`), and GLM-5.2 (`high/xhigh`) wire values, with GPT-5.x native projection and a `high` default | `tests/provider-factory.test.ts`, `tests/reasoning-capabilities.test.ts` | Existing effort defaults and non-effort routes retained |
| `e61f972` (#57), PATCH 8/9 | Extended effort levels also need exposure inside the *injected Claude Code binary* (model-picker/effort UI patch sites), not just proxy-side capability wiring | `src/patch-transforms.ts`, `tests/patcher.test.ts` | `src/patch-transforms.ts` (PATCH 8a/8b/8c/9, `PatchScriptEffort`, `projectNativeEffort`, `RESERVED_MODEL_ALIASES`), `src/patcher.ts` (`reasoningEffortForPatch`, `buildPatchModelConfig`/`buildDesiredPatchConfig`/`computePatchConfigHash` effort wiring), `PATCH_TRANSFORMS_VERSION` bumped 1 → 2 | Manually adapted from the exact upstream anchors (verified against `git show e61f972 -- src/patch-transforms.ts`), not guessed: three wildcarded capability-gate anchors (`effort`/`xhigh_effort`/`max_effort`, each behind the native denylist guard) plus the default-effort resolver anchor, each injecting a baked `Object.create(null)` verdict/default table keyed by lowercased alias and id (bare and `[1m]`-suffixed). Every site is conditional on at least one configured model exposing a supplier effort ladder (`EFFORT_BY_KEY`) and, when it runs, is `required: true` — a missing/ambiguous anchor throws `PatchApplyError` and `patch-transaction.ts`'s existing crash-safe sequence aborts before `commitSameDirectoryStageSync`/`writeManifestV2`, so publication never proceeds on a stale anchor. `projectNativeEffort` only projects a ladder that declares the full low/medium/high base, pinning the projected default to Claude Code's own native custom-identity default (`high`) regardless of the supplier default; a ladder that can't be represented (e.g. GLM-5.2's `high`/`xhigh`-only levels, or an out-of-ladder default) is silently omitted by `buildPatchModelConfig`, while `applyLeverframePatches` itself still hard-rejects malformed effort passed directly. A denylist (`RESERVED_MODEL_ALIASES`: the built-in `sonnet`/`opus`/`haiku`/`fable`/`opusplan`/`best`/`default` identities) blocks alias reassignment, matching the upstream commit's own reserved-alias check. `reasoningEffortForPatch` reuses the same `getReasoningCapabilities` supplier data as the proxy-side wiring (previous row) so the binary-side gates and the request path can never disagree about which levels a model supports. | `tests/patcher.test.ts`: `PATCH 8/9 effort capability gates` (true/false/unknown/denylist/`[1m]`/prototype-name-identity/independent xhigh-vs-max/refresh/removal/anchor-failure-aborts-publication), `buildPatchModelConfig`/`projectNativeEffort`/`reasoningEffortForPatch`/`buildDesiredPatchConfig` (GPT-5.6 distinct levels and native-high default, end to end through `config.json`/`providers.json`), `computePatchConfigHash` (effort-level and effort-default sensitivity), `PATCH_TRANSFORMS_VERSION` (bumped to 2, so `patch-classify.ts`'s existing `transformVersion` mismatch path — from `09f79ad` above — reconciles already-patched installs) | Existing PATCH 1–7 sites, alias/context validation, idempotent re-patch behavior, and the crash-safe transaction sequence (§5.5) are unchanged; effort wiring is purely additive and conditional |
| `164be9d` (#62) | Version and backup provenance can refer to the wrong binary | Launch, patcher, backup module | `src/claude-installation.ts`, `src/patch-state.ts`, `src/patch-reconcile.ts` | Adapted into the per-target (§5.2) state model: baselines are content-addressed by `(version, sha256)` under a canonical-identity directory, manifest `provenance` is one of `live`/`backup`/`legacy-migrated`, and legacy migration only adopts a backup when its recorded version and hash both match the live target | `tests/patch-v2.test.ts`, `tests/patch-lifecycle-fixture.test.ts` | Local Phase C transaction and identity work retained; no cross-installation baseline reuse |
| `2de8cf8` (#26) | Use response correlation concepts in the shared lifecycle design | N/A (design reference only) | `src/execution-session-key.ts`, `src/request-lifecycle.ts` | Used as a design reference, not a literal port: a single tested `resolveExecutionSessionKey` factory replaces prior ad-hoc `claudeSessionId ?? anon:<provider>:<model>` concatenation so both Anthropic and OpenAI routes hash to the same execution scope, and request-lifecycle carries its own request/correlation IDs (§7.2) | `tests/execution-session-key.test.ts`, `tests/request-lifecycle.test.ts`, `tests/execution-tracking.test.ts` | Existing per-route session-id headers retained |
| `495684c` (#30) | Consider process lifecycle logging after correctness work | N/A (design reference only) | `src/request-lifecycle.ts`, `src/execution-checkpoint.ts` | Used as a design reference: request lifecycle states (`accepted/validated/dispatched/first_output/terminal`, §7.2) and execution checkpoints record structured terminal outcomes rather than importing Clodex's standalone process-lifecycle logger | `tests/request-lifecycle.test.ts`, `tests/execution-checkpoint.test.ts` | No separate always-on lifecycle logger added; existing opt-in trace logging retained |
| `5bff8dd` (#43) | Proxy transport failures lack attribution | Proxy, HTTP proxy, trace and error types | `src/provider-error.ts`, `src/upstream-error.ts`, `src/request-lifecycle-error-mapping.ts` | Ported into the shared taxonomy (§7.1): `ProviderErrorCategory` includes `connection`, `dns`, `tls`, `proxy`, `connect_timeout`, `header_timeout`, `idle_timeout`, and `total_timeout`, each carrying phase, HTTP status, provider request ID, OS error code/cause, retryability, and a redacted safe message | `tests/provider-error.test.ts`, `tests/request-lifecycle-error-mapping.test.ts`, `tests/upstream-error.test.ts` | Native Anthropic passthrough error surface retained |
| `5fec19a` (#59) | Alias canonicalization has unsafe fallback behavior | Aliases, routes, proxy, patcher | `src/patch-transforms.ts` | Adapted to fail closed instead of silently falling back: alias input is validated against a safe lowercase pattern and `[1m]`-suffix/context combinations are rejected outright (`PatchApplyError`) rather than coerced, and identities used for the enum/validator/picker/context tables are derived from the same validated value | `tests/patcher.test.ts` | Existing supplier-derived alias and canonical-id resolution retained |

### 16.1 Design-only and not-applicable closures

| Upstream commit | Disposition | Evidence |
| --- | --- | --- |
| `e590981` (#12) | Closed design-only. Deferred, not ported. | Leverframe intentionally keeps launch/patch readiness fail-open (a missing or unverifiable patch state degrades to a warning plus best-effort launch, not a blocked launch) so a broken manifest can never prevent starting Claude Code. Strict wrapper readiness (treating an unready/unverified state as blocking) is a different failure posture that only makes sense if Leverframe adopts Clodex's managed-wrapper supervision workflow, which it has not. No strict-readiness code path, flag, or partial implementation exists anywhere in `src/` (`grep -rn "strict.*readiness\|wrapperReadiness"` returns nothing), so there is no dead code to remove or wire up. |
| `de233d8` (#44) | Closed not applicable. Deferred, not ported. | The upstream fix retries a local OAuth callback listener that Clodex's managed-wrapper workflow owns. Leverframe has no equivalent local callback listener in its OAuth flows (`src/oauth/*`) and does not adopt strict managed-wrapper readiness (see `e590981` above), so the failure mode the fix addresses cannot occur here. No listener-retry code, stub, or partial scaffold exists in `src/` for this path, so there is no dead code left behind by declining the port. |

### 16.2 Remaining upstream items not yet ported

These were re-inspected during this pass and confirmed genuinely open — no implementation, partial or otherwise, was found for them. They are not claimed as complete:

| Upstream commit | Original issue | Status |
| --- | --- | --- |
| `6de7af9` (#54) | Private adapter connections are not reused (no keep-alive) | Superseded for the HTTP-proxy adapter path — see §21. `startHttpProxy` (`src/http-proxy/server.ts`) now owns one `http.Agent({ keepAlive: true })` for every request `forwardToAdapter` sends to the local relay adapter, destroyed once on `HttpProxyHandle.close()`. The SDK-routed paths (`src/sdk-adapter.ts`, `src/openai-adapter.ts`, `src/server/router.ts`) still have no explicit `http.Agent`/`https.Agent`; they go through the AI SDK's own `fetch`, which pools connections via Node's global undici dispatcher by default. That default pooling was not re-verified against upstream's specific concern this pass, so it remains open for those paths. |
| `383f464` (#10) | Configured routes can bypass to another provider | No route-bypass guard was found in `src/server/router.ts` or `src/proxy.ts` beyond existing route resolution. Not ported this pass. |
| `77ae2bf` (#23) | Listener readiness can be reported too early | Leverframe has no local OAuth callback listener equivalent to Clodex's (see `de233d8` above); candidate for closing as not-applicable in a future pass, but not closed here since that determination was not part of this task's explicit instruction. |
| `303db6e` (#33), `32c1f7b` (#38) | WebSocket 403/connection-limit throttle retry semantics | Not found implemented beyond the existing `8485e1c` single bounded retry (already recorded above). Not ported this pass. |

A fix is complete only after its regression tests pass and its disposition row records the actual implementation rather than the planned implementation.

## 17. Phase A and Phase B implementation record

Implemented on 2026-07-28 against Leverframe revision `b5bc3c5e0484e4b546532a2b394930306bfc1c1d`.

Quality-floor restoration includes explicit Git visibility for tests and workflows, 14 selected historical test files, strict source and test typechecking, and Linux CI for frozen install, typechecking, tests, build reproducibility, package inspection, and repository hygiene checks.

The pre-implementation baseline contained 41 tests in 2 files. The final Phase A and Phase B suite contains 368 tests in 20 files.

Final deterministic validation passed:

- Frozen installation with pnpm 10.34.5, including an isolated clean package store
- Source and test TypeScript checking
- All 368 tests and a focused 277-test Phase B run
- Two consecutive deterministic builds
- Candidate-index verification that tracked `dist/` exactly matches the build
- `npm pack --dry-run`
- CLI version and help smoke tests
- Prospective tracked-file secret, machine-path, runtime-state, and temporary-output scanning

The host shell did not provide a global `corepack` executable, so local validation invoked the same package-pinned pnpm through `npx corepack@latest`. The restored Node 24 CI workflow uses `corepack enable` directly.

No live Codex or ChatGPT OAuth request was used as a substitute for deterministic tests. Live interoperability remains a release validation item.

Deferred work at the time of the Phase A/B pass has since been implemented and is recorded in later sections of this document:

- Deterministic Claude installation identity and per-target patch state — Phase C, §16/§16.1 (`src/claude-installation.ts`, `src/patch-state.ts`, `src/patch-classify.ts`, `src/patch-reconcile.ts`)
- Crash-safe patch transaction journaling and migration — Phase C, §16.2 §19 closure (`src/patch-transaction.ts`, `src/patch-lock.ts`, `src/patch-injection.ts`)
- Full provider lifecycle and error taxonomy — Phase D, §20 closure (`src/provider-error.ts`, `src/request-lifecycle.ts`, `src/request-execution-context.ts`)
- Provider-neutral execution checkpoints and persistent tool-call ledgers — Phase E (`src/checkpoint-store.ts`, `src/execution-checkpoint.ts`, `src/execution-recovery.ts`, `src/tool-call-ledger.ts`)
- Credential-generation drift between rotated credentials and cached provider handles — Phase F, §21 closure (`src/provider-runtime-cache.ts`)

Still genuinely open, not stale — see §16.2 for the evidence behind each: `383f464` (route-bypass guard), `77ae2bf` (listener-readiness not-applicable determination not yet made), and `303db6e`/`32c1f7b` (WebSocket throttle/connection-limit retry semantics beyond the existing single bounded retry). `6de7af9` (private-adapter keep-alive reuse) is closed for the HTTP-proxy adapter path only — see §21.

## 18. Deliverable 10 verification pass

Verified on 2026-07-28 against the working tree at the time of this pass (Phase A–B committed at `b5bc3c5`; Phase C, D, and E present as uncommitted working-tree changes: `src/claude-installation.ts`, `src/patch-state.ts`, `src/patch-classify.ts`, `src/patch-reconcile.ts`, `src/patch-transaction.ts`, `src/patch-lock.ts`, `src/patch-injection.ts`, `src/patch-diagnostics.ts`, `src/patch-presenter.ts`, `src/provider-error.ts`, `src/request-lifecycle.ts`, `src/request-lifecycle-error-mapping.ts`, `src/provider-capabilities.ts`, `src/checkpoint-store.ts`, `src/execution-checkpoint.ts`, `src/execution-recovery.ts`, `src/execution-query.ts`, `src/execution-session-key.ts`, `src/execution-tracking.ts`, `src/executions-command.ts`, `src/tool-call-ledger.ts`, `src/tool-call-tap.ts`, `src/deadline-manager.ts`, `src/registry/lock.ts`, `src/registry/credential-cleanup-journal.ts`, `src/registry/credential-lifecycle.ts`, `src/atomic-file.ts`, `src/durable-io.ts`, and their test suites).

This pass re-inspected the exact upstream diffs listed in §9.2/§9.3/§9.5 against the current source (not against comments or attribution markers, which the codebase intentionally does not carry per-hunk) and:

- Confirmed `b5bc3c5`'s refreshed-baseline behavior is intact (§4.1 note; `patch-reconcile.ts` provenance handling).
- Confirmed and recorded completion rows for `105dde5`, `46d4818`, `73661d6`, `09f79ad`, `e61f972` (capability wiring only — see §16.2 for the unclosed PATCH 8/9 binary-injection portion), `164be9d`, `2de8cf8`, `495684c`, `5bff8dd`, and `5fec19a` (§16).
- Re-verified `e653d89` durability against `atomic-file.ts`/`durable-io.ts`/`config.ts` and their concurrency/contention tests; no regression.
- Closed `e590981` design-only and `de233d8` not-applicable with explicit evidence that fail-open patch/launch readiness remains intentional and that no dead or partially-wired code exists for either upstream behavior (§16.1).
- Confirmed `d4ec9e2` (anonymous routes), `f9272d6` (forced refresh), `9657038`/`102e496`/`cae6db6` (credential cleanup/reconciliation/keyring generations), and `502450c` (design reference) remain correctly recorded from the prior pass with no regressions.
- Did **not** find implementations for `6de7af9` (private-adapter keep-alive reuse), `383f464` (route-bypass guard), `303db6e`/`32c1f7b` (WebSocket throttle/connection-limit retry semantics beyond the existing single bounded retry), or a local equivalent to `77ae2bf` (listener readiness). These are recorded as genuinely open in §16.2 rather than marked complete, since inventing an implementation or a closure rationale for them was outside what this pass could verify safely (in the WebSocket-retry and route-bypass cases) or determine conclusively (in the `77ae2bf` not-applicable case).

Validation commands run this pass:

```bash
npx corepack@latest pnpm typecheck   # tsc --noEmit (src) + tsc --noEmit -p tests/tsconfig.json — clean
npx corepack@latest pnpm test        # vitest run — 60 files, 850 passed, 8 skipped, 0 failed
```

No build was run (tracked `dist/` is intentionally not rebuilt during this read/verify/document pass, consistent with §2.1).

## 19. §16.2 closure pass — `e61f972` PATCH 8/9

Closes the PATCH 8/9 row previously left open in §16.2 (the row above, "capability wiring only", is superseded for the binary-injection portion). `git show e61f972 -- src/patch-transforms.ts tests/patcher.test.ts` was inspected directly (not from memory) to derive the exact wildcarded anchors and CLAUDE_FIXTURE test shapes, then manually adapted — not literally ported — into Leverframe's supplier-authoritative capability model. See the completion row appended to §16 for the full implementation and test disposition.

Validation run for this closure, scoped to the changed files (`src/patch-transforms.ts`, `src/patcher.ts`, `tests/patcher.test.ts`):

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json           # clean
node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.json     # clean
npx vitest run tests/patcher.test.ts                                     # 81 passed, 0 failed
```

Other §16.2 rows (`6de7af9`, `383f464`, `77ae2bf`, `303db6e`/`32c1f7b`) were out of scope for this pass and are addressed separately; do not infer their disposition from this section.

## 20. §7.2/§7.3 closure pass — `RequestLifecycle`/`DeadlineManager` production wiring

Closes the "design reference only" disposition on the §16 rows for `2de8cf8` and `495684c`: `src/request-lifecycle.ts` and `src/deadline-manager.ts` previously existed with full unit coverage (`tests/request-lifecycle.test.ts`, `tests/deadline-manager.test.ts`, `tests/request-lifecycle-error-mapping.test.ts`) but had no caller anywhere in the request-serving path — every HTTP/WebSocket entry point ran its own ad hoc idle/total `setTimeout` pair (`src/sdk-adapter.ts`) or no deadline/lifecycle ownership at all (`src/proxy.ts`, `src/server/router.ts`, `src/openai-adapter.ts`, `src/upstream-forward.ts`). This pass wires them in as the single owner, end to end, without duplicating `RequestLifecycle`'s transition logic anywhere else.

**New module: `src/request-execution-context.ts`.** A small request execution context/observer — not a second state machine — that:

- Constructs one `RequestLifecycle` per request (four deadline classes armed from `RequestLifecycle`'s own defaults or a caller-supplied override), linked to a caller-provided downstream-disconnect `AbortSignal`.
- Exposes only a narrow `RequestExecutionObserver` surface (`startResolving`/`startConnecting`/`markHeadersReceived`/`markStreamActivity`/`markOutputEmitted`/`markToolCallEmitted`/`recordRetryAttempt`/`complete`/`fail`/`cancel`/`abortSignal`) — call sites and adapters never see the concrete `RequestLifecycle` instance, so every transition invariant (legal edges, terminal-once, deadline arming) stays owned by `RequestLifecycle` itself.
- Tracks every non-terminal lifecycle in a module-level set and exposes `cancelAllActiveRequestExecutions()`, wired into `ProxyHandle.close()` and `ServerHandle.close()`, so local shutdown settles every in-flight request to a `cancelled` terminal outcome instead of abandoning it.
- `finish(attemptCount)` maps a terminal, non-`completed` outcome through the existing `request-lifecycle-error-mapping.ts` into a `ProviderTransportError`.

**Entry points wired:**

- `src/proxy.ts` (`startProxyCatalog`'s `/v1/messages` handler): one `RequestExecutionContext` per request, created after route resolution and reused across the `count_tokens`, native-Anthropic-passthrough, and SDK-translated branches; `clientAbort` (already used for downstream-disconnect cancellation) doubles as the lifecycle's cancellation signal. `ProxyRoute.requestDeadlines?: LifecycleDeadlines` is a test-only per-route override (production routes never set it, so production behavior is the `RequestLifecycle` defaults: 30s/60s/120s/10min). `ProxyHandle.close()` calls `cancelAllActiveRequestExecutions()`.
- `src/server/router.ts` (`handleAnthropicMessages`, `handleOpenAIChatCompletions`): same pattern, one context shared across each handler's passthrough and SDK branches (previously each branch created its own, unwired `AbortController`). `ServerHandle.close()` calls `cancelAllActiveRequestExecutions()`.
- `src/upstream-forward.ts` (`relayAnthropicMessages`, the shared native-Anthropic/OpenAI-passthrough relay used by both entry points above): drives `startConnecting`/`markHeadersReceived`/`fail` (already present) plus, newly, `markStreamActivity`/`markOutputEmitted` per streamed chunk and on the non-stream JSON body, and `complete`/`fail` on terminal outcome. The streaming branch was changed from a manual `upstream.pipe(...).pipe(res)` chain to `pipeline()` from `node:stream/promises` (the module already imported it but never called it) — `pipeline()` is what makes the terminal outcome truthful: it resolves only once `res` has actually finished, rejects on any failure anywhere in the chain, and destroys every stream in the chain on either path, so a torn-down connection can never leave the lifecycle stuck non-terminal. Byte-for-byte forwarding is unchanged (§11.3 golden-test invariant; see the new E2E byte-invariance test below).
- `src/sdk-adapter.ts` (`streamAnthropicResponse`, `generateAnthropicResponse`, `writeAnthropicStream`): `AnthropicStreamObserver.lifecycle?: RequestExecutionObserver` is threaded through; when present, `lifecycle.abortSignal` (already composed from the caller's cancellation signal plus all four deadline classes) replaces the function-local ad hoc idle/total `setTimeout` pair entirely, and `markStreamActivity`/`markOutputEmitted`/`markToolCallEmitted` are driven from the existing per-part observer hook (`observer?.onPart`) rather than a new one. Terminal transitions (`complete`/`fail`) stay owned by the caller (`proxy.ts`/`server/router.ts`), matching the existing `translationLifecycle` pattern already in `proxy.ts`.
- `src/openai-adapter.ts` (`generateOpenAiResponse`, `streamOpenAiResponse`, `collectOpenAiStream`): same `lifecycle?: RequestExecutionObserver` pattern, mirroring the Anthropic-SDK adapter.
- `src/oauth/responses-websocket.ts`: intentionally **not** touched. It is a `fetch()`-shim transport used inside the same `streamText`/`generateText` calls that now receive the composed `lifecycle.abortSignal` from `sdk-adapter.ts`, so all four deadline classes and downstream-disconnect cancellation already apply to it transparently through that existing abort-signal composition point — adding a second, WebSocket-specific deadline owner would duplicate `RequestLifecycle`, which this pass was explicitly scoped to avoid, and would reopen already-green WebSocket retry/PATCH semantics this task was scoped not to touch.

**Hardening found and fixed during this pass:** `RequestLifecycle.complete()` required the current state to already be `headers`/`streaming`/`tool-call-emitted` (only reachable if an adapter had already driven at least one phase transition). A caller that reaches a legitimate success outcome without any intermediate phase hook firing — e.g., a provider/test double that resolves with zero stream parts — hit `IllegalLifecycleTransitionError` on `complete()`, surfacing as a spurious 502. `complete()` now cascades through `markHeadersReceived()` first (itself idempotent/cascading and a no-op past `headers`), so a clean completion is legal from any non-terminal state without callers needing to know which phase hooks an adapter happened to fire.

**Tests added:** `tests/request-execution-e2e.test.ts` — local-server (`startProxyCatalog`) E2E coverage using `ProxyRoute.requestDeadlines` to fire deadlines in milliseconds:

- Header deadline (upstream accepts the TCP connection, reads the body, never responds) → 502.
- Idle deadline (upstream writes one SSE chunk, then stalls) → truncated 200 stream, connection torn down.
- Total deadline under continuous idle-resetting activity (upstream pings faster than the idle deadline, but the total budget is smaller) → truncated 200 stream.
- Downstream disconnect mid-stream → upstream connection is observably torn down.
- Terminal-once / no cross-request leakage: a request that completes normally does not block or corrupt the next request on the same proxy.
- Malformed/truncated completion: a non-JSON upstream body on a non-streaming request → clean 502 with a diagnostic message, not a hang or a 500.
- Native-passthrough byte invariance under the wiring: a raw Anthropic SSE body is forwarded byte-for-byte with generous (non-firing) deadlines.

A genuine connect-deadline E2E test (TCP handshake that never completes) was not added — deterministically simulating a hung TCP handshake against a local loopback listener is not reliable without OS-level firewall/netem control, unlike header/idle/total which only require a listener that accepts but is slow to respond. The `connect` deadline kind's firing behavior is covered deterministically at the unit level with a fake clock in `tests/deadline-manager.test.ts` and `tests/request-lifecycle.test.ts`.

`tests/request-execution-context.test.ts` (new) covers `src/request-execution-context.ts` directly: encapsulation (the concrete `RequestLifecycle` is never reachable from the returned context — only the narrow observer surface, `getSnapshot()`, and `canReplay()`), `finish()`'s outcome mapping (undefined pre-terminal, undefined on a clean `completed` outcome, a `ProviderTransportError` carrying `provider`/`model`/`attemptCount` on failure, `local_shutdown` category on cancellation), the local-shutdown registry (`cancelAllActiveRequestExecutions()` settles every tracked in-flight context and is a no-op against ones that already completed), and that an external downstream-disconnect `AbortSignal` cancels with origin `local`.

Validation run for this closure:

```bash
node node_modules/typescript/bin/tsc --noEmit                              # clean
node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.json       # clean
npx vitest run                                                              # 65 files, 941 passed, 8 skipped, 0 failed
```

## 21. Phase F closure pass — credential-drift cache fix (`ProviderRuntimeCache`) and `6de7af9` partial closure

Both SDK-translated entry points (`src/proxy.ts`'s catalog handler and `src/server/router.ts`'s `handleAnthropicMessages`/`handleOpenAIChatCompletions`) build a provider `LanguageModel` handle from a route's API key and reuse it across requests. Before this pass, a route's OAuth refresh (`providerRuntimeCache.adopt`/an equivalent ad hoc cache) could publish a new credential while an in-flight or subsequently cached handle still referenced the old one, so a rejected-token refresh and a concurrent request racing the same route could each build (and potentially leak) their own handle for the same credential generation, or a caller could keep using a handle built from a credential that had already rotated underneath it.

**New module: `src/provider-runtime-cache.ts` (`ProviderRuntimeCache<T>`).** Owns two related things per route key, never exposing the raw credential in a cache key or log:

- **Immutable credential generations.** `snapshot()` returns the current `{ generation, fingerprint, credential }` for a route, minting generation 1 on first use; `fingerprint` is a SHA-256 digest, so it is safe to key handles and logs on without leaking the credential itself.
- **Single-flighted handle construction**, keyed by `(routeKey, generation, fingerprint)`, so two concurrent requests for the same still-valid credential share one in-flight `create()` call instead of racing two handle builds; a rejected `create()` promise self-evicts from the cache.
- **Single-flighted rotation.** `refresh()`/`adopt()` both funnel through `rotateSingleFlight`, keyed by the rejected credential's fingerprint: if the current credential has already moved past the rejected one (someone else already rotated), the caller gets the current snapshot back immediately with no redundant refresh call; otherwise exactly one refresh runs and every concurrent caller awaits the same promise.
- **Atomic eviction before publication.** `rotate()` evicts every handle cached under the route's old generation (awaiting each handle's own `disposeHandle` callback, so an old client is closed before a new one can be requested) and only then publishes the new generation via `credentials.set()`. No caller can observe a new credential generation while a handle for the old generation is still reachable from the cache.

This directly fixes the credential-drift class of bug: a provider that rotates an OAuth token can no longer leave a stale-credentialed handle reachable to a new request, and a burst of concurrent 401s against the same rejected token triggers exactly one upstream refresh call, not one per in-flight request.

**Wired in:** `src/proxy.ts:378` (`providerRuntimeCache`, used at the `adopt`/`getHandle` call sites around SDK route construction and 401-triggered refresh) and `src/server/router.ts:313` (`languageModelCache`, threaded through `routeRequest` and its downstream handlers as a required parameter, not a global). Both call sites pass `disposeHandle`/`onCredentialRotated` hooks so a superseded handle's own cleanup (if the provider's SDK exposes one) still runs.

**Tests:** `tests/provider-runtime-cache.test.ts` (6 tests) covers the immutable-snapshot identity guarantee (repeat `snapshot()` calls for one route return the same frozen object regardless of the credential argument), fingerprint non-leakage, single-flighted handle construction under concurrency, single-flighted refresh that publishes exactly one new generation and disposes the stale handle, and idempotent adoption when a concurrent caller already rotated past the rejected credential.

**`6de7af9` (private adapter connections are not reused) — partial closure.** Documented as still open across every prior pass (§16.2, §18). Re-inspecting `src/http-proxy/server.ts` this pass found `startHttpProxy` already owns `const adapterAgent = new http.Agent({ keepAlive: true })`, passed as `forwardToAdapter`'s `agent` option on every relay-adapter request and destroyed exactly once in `HttpProxyHandle.close()`. This closes the HTTP-proxy adapter leg of `6de7af9`. The §16.2 table row is updated in place (superseded, not deleted, matching the `e61f972` convention in §19) rather than left to read as still fully open. The SDK-routed paths (`src/sdk-adapter.ts`, `src/openai-adapter.ts`) remain unverified for this specific upstream concern and are not claimed closed.

Validation run for this closure:

```bash
npx tsc --noEmit -p tsconfig.json                                          # clean
npx tsc --noEmit -p tests/tsconfig.json                                    # clean
npx vitest run tests/provider-runtime-cache.test.ts                        # 6 passed, 0 failed
```

## 22. Phase G — HTTP-proxy adapter-vs-native-Anthropic routing extracted to an application service

The `mitmServer` request handler in `src/http-proxy/server.ts` mixed transport concerns (auth, body reads, response writing) with the adapter-vs-native-Anthropic routing decision and the inference/WebSocket-diagnostic log orchestration that decision depends on. This pass extracts that decision into `src/http-proxy/routing-decision.ts`, an application service with no HTTP or transport dependency:

- `decideHttpProxyRoute()` returns an exhaustive `HttpProxyRouteDecision` union (`'translated' | 'passthrough-messages' | 'raw'`) and, as its one side effect, writes the request-side `writeInferenceRequestLog`/`writeWebSocketDiagnosticRequestLog` entries the decision already needed to compute (provider, route kind, session id, model id).
- The handler in `src/http-proxy/server.ts` now only authenticates (unchanged Proxy-Authorization/CONNECT checks), reads the raw body, calls the service, and `switch`es on `decision.action` to dispatch to `forwardToAdapter`/`forwardRawAnthropicRequest` and write the response — with a `never`-typed default case, so an unhandled future action fails typecheck rather than falling through silently.
- Fail-closed behavior is unchanged and now lives in one place: an unparsable body or an unresolved route id leaves `route` unset in the service, which the handler can only ever reach through the `'passthrough-messages'`/`'raw'` cases — there is no code path back to `'translated'` from a decision that didn't resolve a route.
- Raw passthrough bytes, `adapterAgent` keepalive ownership/close, CONNECT tunnel handling, execution tracking, lifecycle hooks (`response_started`/`response_progress`/`response_completed`/`response_failed`/`response_client_disconnected`/`response_usage`), cancellation on client disconnect, and log-content privacy (no conversation content logged unless the existing request-preview opt-in env var is set) are all unchanged — the extraction only moved *which function* decides and logs, not what the transport functions do with that decision.

**Tests:** `tests/http-proxy-routing-decision.test.ts` (14 new pure unit tests) covers the service directly: raw for non-POST and non-`/v1/messages*` paths, `count_tokens` dispatching to the adapter but never logging or attaching a lifecycle, fail-closed passthrough on an unmatched model id / no running adapter / an unparsable body, adapter dispatch only when both a route and an adapter exist, `route: 'translated'`/`route: 'passthrough'` and provider recorded correctly, no request-preview content logged by default, and Claude-session-id extraction/redaction (including rejecting a malformed session id). The existing `tests/http-proxy-server.test.ts` suite (20 integration tests, unchanged) continues to pass unmodified against the refactored handler, including its `count_tokens`-not-logged, translated/passthrough lifecycle, and privacy assertions.

Validation run for this closure:

```bash
npx tsc --noEmit -p tsconfig.json                                                  # clean
npx tsc --noEmit -p tests/tsconfig.json                                            # clean
npx vitest run tests/http-proxy-routing-decision.test.ts tests/http-proxy-server.test.ts tests/http-proxy-routes.test.ts tests/http-proxy-index.test.ts
# 4 files, 41 passed, 0 failed
npx vitest run                                                                      # 66 files, 957 passed, 8 skipped, 0 failed
```

Explicitly out of scope for this pass and unchanged: `route.apiKey` mutation on OAuth token refresh in `proxy.ts`/`server/router.ts` (credential-adjacent; this task's brief prohibits mutating credential handling), and any refactor of the WebSocket connection-pool/retry semantics in `src/oauth/responses-websocket.ts` beyond the transparent abort-signal composition described above.

## 23. Final verification pass — unused import cleanup and evidence refresh

`src/http-proxy/server.ts` imported `INFERENCE_PROGRESS_INTERVAL_MS` from `../trace-log.js` after the §22 routing extraction moved its only call site (`progressIntervalMs: ... ?? INFERENCE_PROGRESS_INTERVAL_MS`) into `src/http-proxy/routing-decision.ts`. `tsconfig.json` does not set `noUnusedLocals`, so the stale import compiled cleanly but was dead weight. Removed the unused named import from `server.ts`; `routing-decision.ts` already imports and uses the constant directly, so behavior (the response-progress log interval) is unchanged.

`grep -rn "route\.apiKey\s*="` and a broader `\.apiKey\s*=` sweep across `src/` both confirm the credential-adjacent boundary noted at the end of §22 remains untouched — zero direct `apiKey` mutations exist anywhere in source; OAuth rotation continues to flow only through `ProviderRuntimeCache` (§21).

Validation run for this closure:

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json         # clean
node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.json   # clean
npx vitest run                                                          # 66 files, 959 passed, 8 skipped, 0 failed
```

The two additional passing tests versus §22's recorded `957 passed` are pre-existing `tests/provider-runtime-cache.test.ts` coverage (7 tests, up from the 6 recorded in §21) already present in the working tree; this pass did not add or modify any test file. Two consecutive `tsup` builds of `dist/cli.js`, `dist/claude-wrapper.js`, and the single `dist/chunk-*.js` were confirmed byte-for-byte identical (`diff -rq`), and the tracked working-tree `dist/` matches that deterministic output exactly. `node scripts/verify-package-contents.mjs` and `leverframe patch --diagnose --json` (run only against a disposable temp-directory fixture binary, never a real Claude installation) both passed; the fixture binary's SHA-256 before and after diagnose was identical, confirming the diagnose path is read-only.

## 24. Definitive final verification-and-fix pass

Re-verified end to end against the working tree described in §22/§23 (Phase A–B committed at `b5bc3c5`; Phase C–G present as uncommitted working-tree changes, including the §21 `ProviderRuntimeCache` credential-drift fix, the §22 HTTP-proxy routing-decision extraction, and the §23 unused-import cleanup). No source, test, or `dist/` change was needed this pass; one CI-workflow hygiene defect was found and fixed.

**Scope confirmed runtime-reachable, no legacy V1 patch runtime remaining beyond the documented reader.** `src/patcher.ts` is 215 lines: `runPatchCommand`/`runLaunchPatchCheck` delegate exclusively to the V2 transaction path (`runPatchCommandV2`/`runLaunchPatchCheckV2`/`diagnosePatchV2`, all in `src/patch-*.ts`); the sole remaining V1 surface is `readPatchManifest`, used only by `src/patch-reconcile.ts` (`migrateLegacyStateIfVerified`) and `src/patch-diagnostics.ts` (read-only `legacyManifestPresent`/migration-eligibility reporting) — exactly the narrowly scoped migration reader the plan calls for, with no duplicate apply/write path. Every new Phase C–F module (`atomic-file`, `checkpoint-store`, `claude-installation`, `deadline-manager`, `durable-io`, `execution-checkpoint`, `execution-query`, `execution-recovery`, `execution-session-key`, `execution-tracking`, `executions-command`, `http-proxy/routing-decision`, `listener-ready`, `patch-classify`, `patch-diagnostics`, `patch-injection`, `patch-lock`, `patch-presenter`, `patch-reconcile`, `patch-state`, `patch-transaction`, `provider-capabilities`, `provider-error`, `provider-runtime-cache`, `reconcile-tool-call-workflow`, `registry/credential-cleanup-journal`, `registry/credential-lifecycle`, `registry/lock`, `request-execution-context`, `request-lifecycle-error-mapping`, `request-lifecycle`, `tool-call-ledger`, `tool-call-tap`) was confirmed imported from at least one other production `src/` file (not only its own test), i.e. wired into a live entry point rather than orphaned.

**Checkpoint/ledger secret and hidden-reasoning boundary.** `src/execution-checkpoint.ts`'s `isSupportedCheckpoint` allowlist-plus-denylist guard (`FORBIDDEN_FIELD_NAMES` including `reasoning`, `thinking`, `apiKey`, `authorization`, `credential`, `prompt`, `messages`, raw tool args/results/bodies) is exercised on every read/write through `readDocument`/`writeDocumentCAS` (`src/checkpoint-store.ts`) and covered by `tests/execution-checkpoint.test.ts`/`tests/checkpoint-execution-ledger.test.ts` — not dead code.

**`route.apiKey`/`model.apiKey` assignment scan.** `grep -rn "\.apiKey\s*="` and a `route\.apiKey\s*=|model\.apiKey\s*=` sweep across `src/` both return zero matches; OAuth rotation still flows only through `ProviderRuntimeCache` (§21), matching §23's finding with no regression.

**CI hygiene defect found and fixed.** `.github/workflows/ci.yml`'s "Reject secrets and machine-specific files" step ran `git grep` for private-key markers, long `sk-`-prefixed tokens, and `/Users/`/`/private/tmp/` paths against every tracked file except `ci.yml` itself. The currently-untracked test suite (already present in the working tree, pending commit) legitimately contains synthetic fixtures that trip every one of those patterns by design: `tests/checkpoint-store.test.ts`/`tests/checkpoint-execution-ledger.test.ts` hash literal `/Users/me/...`/`/Users/example/...` paths to prove `workspaceOrSessionHash` stability and uniqueness, `tests/config.test.ts` records literal `/Users/jbendavi/...` launch folders, `tests/wrapper-env.test.ts` sets a synthetic `HOME: '/Users/someone'`, and `tests/execution-checkpoint.test.ts`/`tests/trace-log.test.ts` construct synthetic `sk-`-shaped strings specifically to assert they get redacted or rejected. None of this is a real leak — `tests/` is not in `package.json`'s `files` allowlist and never ships — but as written, committing these test files would make the CI hygiene step fail on its own intentional test fixtures. Fixed by adding `':(exclude)tests/**'` to the `git grep` pathspec alongside the existing `ci.yml` exclude, so the scan still covers `src/`, `dist/`, `docs/`, `README.md`, `package.json`, and every other shipped or repo-hygiene-relevant path. Re-ran the exact CI grep (all four patterns, `--untracked` to include the pending test files) against the corrected pathspec: clean. Re-ran it without the new exclude to confirm the defect was real before the fix (11 matches, all inside `tests/**`, all synthetic fixtures — no real secret or machine path was found anywhere, including in `tests/`).

**Runtime-state filename scan**, tracked and untracked: `git ls-files` plus `git ls-files --others --exclude-standard`, filtered against `(checkpoint|credentials-fallback|patch-state|server-runtime|manifest|transaction|tool-call-ledger|credential-cleanup-journal)\.json$|\.tmp$` — clean, no committed or pending runtime-state artifact.

**Source maps and machine paths in shipped output.** `dist/*.js.map` exist in the build output but are excluded by `package.json`'s `files` allowlist (`dist/*.js` only); confirmed via `npm pack --dry-run` (8 files, no `.map`, no `tests/`, no `docs/stabilization-and-upstream-plan.md`) and `node scripts/verify-package-contents.mjs` (8 files, 3097633 bytes). No `/Users/michael` or other real machine path appears anywhere in tracked or untracked `src/`, `dist/`, `docs/`, or `README.md`.

**Dead-helper/TODO/stub scan.** `grep -rniE "TODO|FIXME|XXX|HACK:|not implemented|unimplemented"` across `src/` returns one hit: `src/oauth/refresh.ts`'s `throw new Error(\`OAuth refresh not implemented for provider "${providerId}"\`)` — a fail-closed guard for a provider id with no refresh path (not a stub; it is the correct terminal branch for an unsupported provider). No `.only(` in any test file.

**Two deterministic builds and fresh-build-vs-tracked-`dist` consistency**, re-run this pass with newly created, uniquely-named scratch directories (a prior run reused generically-named `build1`/`build2` scratch directories that turned out to collide with leftover state from another agent sharing this session's scratchpad, producing a false nested-directory diff; re-run with collision-proof names to get a clean result): `npx tsup` twice, `diff -rq` between the two outputs — identical; `diff -rq` between the tracked working-tree `dist/` and a fresh build — identical.

**CLI smoke tests**, all under a freshly created, isolated `$HOME` (never a real installation or credential store): `leverframe --version` → `0.1.0`; `leverframe --help` and `leverframe patch --help` render correctly and match README's command block verbatim; `leverframe executions list` against the clean `$HOME` reports `No executions found.`; `leverframe patch --diagnose --json --target <fixture>` against a disposable `mkdtemp`-created shell-script fixture (built the same way `tests/patch-lifecycle-fixture.test.ts` builds its fixtures: a real executable that prints a version and carries the baseline patch-site source as inert shell text) returned a full diagnostics report (`state: "unsupported"` — correct, since the fixture was never patched) with the fixture's SHA-256 identical before and after, confirming diagnose never mutates its target.

Validation commands run this pass (sandboxed `$HOME` for every command that touches `~/.leverframe`, `~/.claude`, or an OS keychain):

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json         # clean
node node_modules/typescript/bin/tsc --noEmit -p tests/tsconfig.json   # clean
HOME=<sandbox> npx vitest run                                          # 66 files, 954 passed, 8 skipped, 0 failed
HOME=<sandbox> npx vitest run <31 restart/failpoint/migration/diagnose/capability/lifecycle/deadline/checkpoint/ledger/credential/upstream/native/wrapper/routing test files>
                                                                         # 31 files, 406 passed, 5 skipped, 0 failed
grep -rn '\.apiKey\s*=' src/                                            # none
git grep -nIE <secret/machine-path patterns> -- . ':(exclude).github/workflows/ci.yml'              # clean (tracked)
git grep -nIE --untracked <same patterns> -- . ':(exclude).github/workflows/ci.yml' ':(exclude)tests/**'  # clean (tracked + pending)
git ls-files; git ls-files --others --exclude-standard  # filtered for runtime-state filenames — clean
npx tsup && npx tsup && diff -rq <two build outputs>                    # identical
diff -rq dist <fresh build>                                             # identical
node scripts/verify-package-contents.mjs                                # 8 files, 3097633 bytes
npm pack --dry-run                                                      # 8 files, no .map/tests/plan doc
HOME=<sandbox> node dist/cli.js --version                               # 0.1.0
HOME=<sandbox> node dist/cli.js --help                                  # matches README
HOME=<sandbox> node dist/cli.js patch --help                            # matches README
HOME=<sandbox> node dist/cli.js executions list                         # "No executions found."
HOME=<sandbox> node dist/cli.js patch --diagnose --json --target <mkdtemp fixture>  # read-only, SHA unchanged
git status --short                                                      # only expected Phase C-G modified/untracked files, plus this section and the ci.yml fix
```

No `pnpm install`, `git add`, `git commit`, `git push`, credential store write, or real Claude Code installation was touched at any point in this pass.
