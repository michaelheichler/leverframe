# leverframe Roadmap

**Goal:** leverframe

**Scope:** 6 phases

## Progress
| Phase | Status | Plans | Tasks | Commits |
|-------|--------|-------|-------|---------|
| 1 | Pending | 0 | 0 | 0 |
| 2 | Pending | 0 | 0 | 0 |
| 3 | Pending | 0 | 0 | 0 |
| 4 | Pending | 0 | 0 | 0 |
| 5 | Pending | 0 | 0 | 0 |
| 6 | Pending | 0 | 0 | 0 |

---

## Phase List
- [ ] [Phase 1: Local Model Runtime: Hardware Detection & Core Engine](#phase-1-local-model-runtime-hardware-detection-core-engine)
- [ ] [Phase 2: Local Model Registry & Browser](#phase-2-local-model-registry-browser)
- [ ] [Phase 3: Local Model Lifecycle: Caching, Load/Unload & Timeout Gates](#phase-3-local-model-lifecycle-caching-load-unload-timeout-gates)
- [ ] [Phase 4: Local Model Trust & Tool-Calling Gate](#phase-4-local-model-trust-tool-calling-gate)
- [ ] [Phase 5: CharXiv Chart Agent: Core Integration](#phase-5-charxiv-chart-agent-core-integration)
- [ ] [Phase 6: CharXiv as a Registered Model](#phase-6-charxiv-as-a-registered-model)

---

## Phase 1: Local Model Runtime: Hardware Detection & Core Engine

**Goal:** Detect available hardware (Apple Silicon/MLX vs NVIDIA/CUDA vs CPU-only) and stand up a minimal native inference engine per platform, no third-party runtime such as Ollama or LM Studio.

**Requirements:** Local model runtime with hardware-aware automatic context-window detection, No Ollama/LM Studio dependency, native runtime built by us, MLX-native inference support (Apple Silicon), CUDA/NVIDIA inference support (testable on workstation 10.0.10.106, user tux)

**Success Criteria:**
- A small tool-calling-capable model runs locally via MLX on a Mac
- The same runtime runs the equivalent model via CUDA on the workstation at 10.0.10.106
- Context window sizing is derived from detected hardware, not hardcoded

**Dependencies:** None

---

## Phase 2: Local Model Registry & Browser

**Goal:** Build the model catalog/browser experience: hardware requirements shown per model, use-case categories, and BM25 search, integrated into leverframe's existing provider/model listing UX.

**Requirements:** Model browser showing per-model hardware requirements, Model browser with best use case categorization, BM25 search index over the local model catalog

**Success Criteria:**
- Local models are listed alongside existing remote provider models
- Each local model entry shows its hardware requirements
- Models are filterable by use-case category and searchable via BM25

**Dependencies:** Phase 1

---

## Phase 3: Local Model Lifecycle: Caching, Load/Unload & Timeout Gates

**Goal:** Smart load/unload with caching, timeout gates calibrated to measured hardware headroom, reusing leverframe's existing checkpoint/durable-io patterns where applicable.

**Requirements:** Smart load/unload caching, timeout gates calibrated to measured hardware headroom

**Success Criteria:**
- Idle local models unload automatically after a hardware-calibrated timeout
- A previously-loaded model reloads quickly on a cache hit
- Memory/VRAM usage stays within a configurable budget

**Dependencies:** Phase 2

---

## Phase 4: Local Model Trust & Tool-Calling Gate

**Goal:** Enforce tool-calling-native-only inclusion in the local model catalog, and record a minimal vetting checklist while full vetting criteria stay a backlog item.

**Requirements:** Tool-calling required natively, no model offered unless it supports tool calling, Model vetting/trust criteria, deferred to backlog as a Todo, not a blocking requirement

**Success Criteria:**
- The catalog cannot surface a model that lacks native tool-calling support
- A minimal, documented vetting checklist exists even though full vetting criteria remain a backlog Todo

**Dependencies:** Phase 3

---

## Phase 5: CharXiv Chart Agent: Core Integration

**Goal:** Wire in CharXiv (github.com/princeton-nlp/CharXiv) so an agent can submit a chart and get back structured understanding plus guidance for building a better chart.

**Requirements:** CharXiv (princeton-nlp/CharXiv) integration for chart understanding and chart building, callable by agents

**Success Criteria:**
- An agent can call CharXiv against a chart image or spec and receive a structured interpretation
- The interpretation includes actionable guidance for improving the chart

**Dependencies:** Phase 4

---

## Phase 6: CharXiv as a Registered Model

**Goal:** Expose CharXiv through leverframe's own provider/model registry so it appears as a selectable model rather than a hidden side tool, following an explicit chart-submission schematic.

**Requirements:** CharXiv registered as a selectable model in leverframe's own provider/model system, following a defined chart-submission schematic

**Success Criteria:**
- CharXiv appears in the model/favorites listing like any other provider model
- Invoking CharXiv as a model follows the defined chart-submission schematic end to end

**Dependencies:** Phase 5

