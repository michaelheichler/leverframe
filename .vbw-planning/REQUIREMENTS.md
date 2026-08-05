# Requirements

Defined: 2026-08-05

## Requirements

### REQ-01: Local model runtime with hardware-aware automatic context-window detection
**Must-have**

### REQ-02: No Ollama/LM Studio dependency, native runtime built by us
**Must-have**

### REQ-03: MLX-native inference support (Apple Silicon)
**Must-have**

### REQ-04: CUDA/NVIDIA inference support (testable on workstation 10.0.10.106, user tux)
**Must-have**

### REQ-05: Model browser showing per-model hardware requirements
**Must-have**

### REQ-06: Model browser with best use case categorization
**Must-have**

### REQ-07: BM25 search index over the local model catalog
**Must-have**

### REQ-08: Smart load/unload caching, timeout gates calibrated to measured hardware headroom
**Must-have**

### REQ-09: Tool-calling required natively, no model offered unless it supports tool calling
**Must-have**

### REQ-10: Model vetting/trust criteria, deferred to backlog as a Todo, not a blocking requirement
**Must-have**

### REQ-11: CharXiv (princeton-nlp/CharXiv) integration for chart understanding and chart building, callable by agents
**Must-have**

### REQ-12: CharXiv registered as a selectable model in leverframe's own provider/model system, following a defined chart-submission schematic
**Must-have**

### REQ-13: One translation core behind two bridge modes (proxy and gateway)
**Must-have**

### REQ-14: Shared hardened I/O as a trust boundary primitive for persistence
**Must-have**

### REQ-15: Transactional-journaled-reconcilable pattern for risky state mutations
**Must-have**

## Out of Scope

_(To be defined)_

