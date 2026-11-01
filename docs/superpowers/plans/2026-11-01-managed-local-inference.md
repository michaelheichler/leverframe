# Managed Local Inference Implementation Plan

> **For agentic workers**
> REQUIRED SUB-SKILL is superpowers:executing-plans. Implement the tasks in order.

**Goal**
Let users explicitly install and run a small, validated set of local coding and compaction models managed by Leverframe.

**Architecture**
A platform-neutral manager owns catalog records, verified artifacts, memory reservations, and runtime lifecycle. An MLX adapter invokes the underlying runtime and exposes a private loopback endpoint to the existing provider path. A later NVIDIA adapter implements the same contract. The existing `WorkerSupervisor` is a lifecycle reference, but its single-response protocol cannot carry coding streams.

**Tech Stack**
TypeScript, Node 22, Vitest, Python, MLX, and the existing OpenAI-compatible provider adapter.

**Spec**
`docs/superpowers/specs/2026-11-01-account-pools-compaction-local-design.md`

## Global Constraints

- Downloads require explicit action. Never silently upgrade an installed revision.
- Pin model revision, artifact identity, quantization, license, memory requirements, validated context, tool support, and verification date. Distinguish coding and compaction capabilities.
- Choose exact entries from current publisher material and local validation. Do not advertise unverified capabilities.
- Apple Silicon with MLX comes first, then Linux with NVIDIA GPUs. Users do not manage another inference application.
- Coding entries pass tool-use and streaming checks through the Claude Code adapter. Compaction entries preserve required information and reduce total tokens.
- Default checks make no provider or model API calls and never run headless Claude. User-run interactive Claude Code checks cover behavior deterministic fixtures cannot establish.
- Run GitNexus upstream impact before editing existing symbols and report callers, processes, and risk. Confirm UNKNOWN with source search. Run complete graph change analysis before each commit.
- Coding workers use GPT-6.1 Terra at High. Independent QA uses Luna at Max.

## Review Focus

- Canceled or interrupted downloads never appear installed. Task 1 tests staging cleanup and restart.
- Changed revisions, missing files, and corrupted artifacts never launch. Task 1 tests manifests and digests.
- Concurrent processes cannot overcommit memory or unload an active stream. Task 2 tests reservations and leases.
- Runtime crashes and midstream errors terminate callers and release leases. Task 3 tests both paths.
- Removal cannot delete live artifacts or escape the managed root. Tasks 1 and 2 test path containment and busy removal.

## File Structure

- Create `src/local/catalog.ts` for catalog records and compatibility checks, and `src/local/artifacts.ts` for explicit installation, verification, and removal.
- Create `src/local/runtime.ts` and `src/local/manager.ts` for platform-neutral runtime and shared lifecycle contracts.
- Create `src/local/mlx-runtime.ts` and `src/local/mlx-server.py` for the managed MLX process and loopback transport.
- Create `src/local/nvidia-runtime.ts` and its runtime helper in the later Linux stage.
- Extend the hardware probe, registry/provider path, CLI, packaging, and compaction integration at their established seams after graph impact checks.
- Create corresponding `tests/local-*.test.ts` files and a deterministic fake runtime fixture under `tests/fixtures/`.

### Task 1. Catalog and verified artifact installation

**Files**
Create `src/local/catalog.ts`, `src/local/artifacts.ts`, `tests/local-catalog.test.ts`, and `tests/local-artifacts.test.ts`.

**Interfaces**
- `LocalModelEntry` contains an ID, immutable revision, artifact paths, URLs, sizes and SHA-256 digests, quantization, license, minimum memory, validated context, tool support, verification date, and coding or compaction capabilities.
- `installModel(entry, options)` accepts a managed root, abort signal, and injected fetch. It returns `Promise<void>`. `verifyModel(entry, root)` returns `Promise<boolean>`. `removeModel(entry, root)` returns `Promise<void>` and requires exclusive removal ownership.

- [ ] Write tests asserting invalid metadata and unsupported hardware produce a reason before any fetch. Assert the catalog never advertises validation without dated tool or compaction evidence.
- [ ] Write fixture download tests for pinned URLs and hashes, atomic publication, corruption and missing files, canceled and interrupted staging, unchanged installed revisions, and traversal or symlink escape rejection.
- [ ] Run `pnpm exec vitest run tests/local-catalog.test.ts tests/local-artifacts.test.ts` and confirm failure for the missing modules.
- [ ] Implement bounded streaming downloads to staging inside the managed root, size and SHA-256 checks, atomic rename, and safe recovery of abandoned staging. Add a small catalog only after publisher evidence and local validation establish each field.
- [ ] Rerun the command, then run `pnpm typecheck` and `pnpm lint`. Confirm all pass.
- [ ] Run GitNexus `detect-changes --scope all`, resolve incomplete or risky results, then commit the task.

### Task 2. Shared lifecycle and memory budget

**Files**
Create `src/local/runtime.ts`, `src/local/manager.ts`, `tests/local-manager.test.ts`, and `tests/fixtures/local-runtime-fixture.mjs`. Modify `src/context/local-hardware-probe.ts` only as needed.

**Interfaces**
- `LocalRuntime` provides asynchronous `start(entry, artifactPath)`, returning a loopback base URL, `stop()`, and `isHealthy()`.
- `LocalModelManager` provides asynchronous `acquire(modelId)`, returning a base URL and idempotent `release()`, plus `stop(modelId)` and `remove(modelId)`.
- `acquire` verifies artifacts and hardware, then obtains a cross-process memory reservation. An active request holds a lease until its stream ends or the caller cancels it.

- [ ] Write fake clock and process tests for concurrent acquisitions across processes, insufficient memory, critical pressure, stale owner recovery, startup failure, idempotent release, idle timer cancellation on reuse, and crash cleanup.
- [ ] Assert idle unload waits for the last lease. Assert stop and removal refuse active leases, removal clears artifacts after stop, and failed startup releases its reservation.
- [ ] Run `pnpm exec vitest run tests/local-manager.test.ts` and confirm failure for the missing manager.
- [ ] Implement the contract using existing locks where suitable. Account for model load peaks and headroom. Bound lock waits, keep state secret-free, and verify process identity before termination. Use a single owner per runtime across processes with leases and stale-owner recovery.
- [ ] Rerun the command, then run `pnpm typecheck` and `pnpm lint`. Confirm all pass.
- [ ] Run complete GitNexus graph change analysis, resolve findings, then commit the task.

### Task 3. MLX runtime, provider, and compaction integration

**Files**
Create `src/local/mlx-runtime.ts`, `src/local/mlx-server.py`, `tests/local-mlx-runtime.test.ts`, and `tests/local-provider.test.ts`. Modify registry, provider selection, CLI routing, compaction integration, and package inclusion at graph-confirmed seams.

**Interfaces**
- `MlxRuntime` implements `LocalRuntime`. Its managed Python environment uses pinned MLX inference dependencies and the installed artifact path. Startup never downloads models.
- The local provider acquires an installed coding model, routes OpenAI-compatible streaming through the existing Claude Code translation path, and releases on completion, cancellation, or failure.
- `ManagedLocalSummaryEngine` implements and registers with the shared `SummaryEngine` from the context plan. It acquires only a compaction-capable model through `LocalModelManager`, returns a structured summary, source IDs, and actual runtime input/output token usage, then releases its lease. The shared request policy applies coverage and tool-boundary validation and retains the original request on failure. Missing or invalid runtime usage fails the summary operation, so the policy retains the original request and reports the reason.
- CLI actions expose catalog and compatibility, explicit install, status, stop, and remove. Install reports incompatibility before downloading.

- [ ] Write fake-runtime tests for readiness timeout, startup failure, ephemeral loopback binding, stop cleanup, missing dependencies, and no startup download. Check package contents include the Python helper and pinned dependency instructions.
- [ ] Write provider tests for installed-only registration, streamed text and tool calls through the existing adapter, cancellation, errors before and after output, and lease release. Reject arbitrary endpoint hosts.
- [ ] Write compaction tests for capability filtering, coverage and tool-pair validation, unchanged original on invalid output, and net token accounting using representative coding fixtures.
- [ ] Run `pnpm exec vitest run tests/local-mlx-runtime.test.ts tests/local-provider.test.ts` and confirm failure for the missing integration.
- [ ] Implement MLX through its underlying runtime library. Pin the environment and provide reproducible installation and diagnostics. Wire the existing provider, CLI, and compaction seams through their normal error and validation paths.
- [ ] Rerun targeted tests, then run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm check:package`. Confirm all pass without provider or model API calls.
- [ ] Record local validation of tool use, streaming, coverage, net tokens, memory peak, and artifact digests. The user runs an interactive Claude Code session for each coding candidate. Do not mark that acceptance complete without its result.
- [ ] Run complete GitNexus graph change analysis, resolve findings, then commit. Independent QA reviews the MLX stage before NVIDIA work starts.

### Task 4. Linux and NVIDIA platform stage

**Files**
Create `src/local/nvidia-runtime.ts` with a platform helper alongside it. Tests live in `tests/local-nvidia-runtime.test.ts`. Extend the hardware probe and catalog as required, and include the helper in packaging.

**Interfaces**
- `NvidiaRuntime` implements the same `LocalRuntime` endpoint, readiness, stop, and error semantics as MLX.
- Hardware detection reports NVIDIA availability and usable GPU memory separately from system memory. Unknown values block launch with a reason.

- [ ] Write fake hardware and runtime tests for unsupported driver or GPU, unknown and insufficient VRAM, concurrent reservations, startup failure, stream cleanup, idle unload, and removal. Run `pnpm exec vitest run tests/local-nvidia-runtime.test.ts` and confirm failure.
- [ ] Select and pin an underlying NVIDIA inference runtime using current primary documentation and verify its license and packaging. Implement the shared contract without requiring a separately managed inference app. Include only artifacts supported by evidence and local validation.
- [ ] Record the validation host and GPU before hardware acceptance. No Linux/NVIDIA runner currently has authorization or confirmed availability. Keep real hardware acceptance outstanding until a suitable host supplies results, while deterministic runtime tests still run locally.
- [ ] Rerun the targeted test and all checks from Task 3. Run real Linux and NVIDIA validation and record the same evidence as MLX. User-run interactive Claude Code checks remain required for coding entries.
- [ ] Run complete GitNexus graph change analysis, resolve findings, then commit. Independent QA reviews this stage.

## Model evidence

The controller verified the [MLX LM project](https://github.com/ml-explore/mlx-lm) and its server on 2026-11-01. The [Qwen3-Coder-Next publisher announcement](https://qwen.ai/blog?id=qwen3-coder-next) and its [MLX artifact](https://huggingface.co/mlx-community/Qwen3-Coder-Next-4bit) identify a coding candidate with substantial memory needs. Qwen3.6-35B-A3B-OptiQ-4bit and Qwen3.5-4B-OptiQ-4bit are candidates for validation. Verify the artifact and runtime compatibility before inclusion. The Qwen3.5-4B-MLX-4bit card requires mlx-vlm and is not evidence that mlx-lm supports that artifact. Pin immutable revisions and digests after evidence gathering. These candidates are not yet validated catalog entries.
