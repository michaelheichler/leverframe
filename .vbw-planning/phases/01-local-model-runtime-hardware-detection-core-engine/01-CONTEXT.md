# Phase 1: Local Model Runtime: Hardware Detection & Core Engine: Context

Gathered: 2026-08-05
Calibration: architect

## Phase Boundary

Detect available hardware (Apple Silicon/MLX vs NVIDIA/CUDA vs CPU-only) and stand up a minimal native inference engine per platform, no third-party runtime such as Ollama or LM Studio. The engine's API must be model-agnostic from the start (accepts any model id, weights path, and backend), so Phase 2's model registry/browser can plug in without reworking this layer. The registry, catalog UI, and BM25 search themselves stay out of scope for this phase, that is Phase 2.

## Decisions Made

### Runtime implementation strategy + process architecture
- In-process native N-API bindings, loaded directly into the existing leverframe Node process. No Python subprocess, no sidecar server, no shelling out to Ollama/LM Studio.
- Apple Silicon path: `node-mlx` (sebastian-software, MIT). Native N-API binding on Apple's MLX framework. Requires macOS 14+, Apple Silicon, Node 20+.
- NVIDIA/CUDA path: `node-llama-cpp`. Native N-API binding over llama.cpp with a documented CUDA build (`npx node-llama-cpp source download --gpu cuda`), requires CUDA Toolkit 13.1+ and matching NVIDIA drivers.
- Rationale: matches the existing process/discovery pattern already established in `src/server-runtime.ts`, one Node process registers its own runtime state for sibling processes to discover. Native in-process avoids subprocess spawn overhead and IPC serialization, and avoids a second language runtime to package. Both libraries are mature and actively maintained as of Aug 2026.

### Model weight format support
- Support both formats, selected by detected hardware, not user-facing.
- CUDA path loads GGUF via `node-llama-cpp`.
- Apple Silicon path loads MLX-native weights via `node-mlx` (pre-converted `mlx-community` builds where available, `mlx_lm.convert` from safetensors as fallback).
- Rationale: each native binding only consumes one format, this isn't a compromise, it's what the chosen libraries actually require. Also sets up Phase 2's registry to key weight format off hardware requirement.

### Hardware detection method
- Use each library's own native device-inspection API as the primary signal. `node-llama-cpp` reports CUDA availability and free/used VRAM directly. `node-mlx` queries unified memory directly since MLX arrays live in the shared CPU/GPU pool.
- Explicitly not shelling out to `sysctl`/`nvidia-smi` and parsing text output, the libraries already expose this as structured data.

### Context-window sizing
- Derived from a KV-cache memory formula, not hardcoded or looked up from a table.
- Formula: `KV cache bytes per token = 2 x layers x kv_heads x head_dim x bytes_per_element`. Total KV cache = that value x context_length.
- Sizing: `available_memory (with safety margin, e.g. 90% of free) - model_weights_size = memory_budget_for_kv_cache`, then `max_context = memory_budget_for_kv_cache / kv_cache_bytes_per_token`.
- `available_memory` comes from the hardware-detection step (free VRAM for CUDA, free unified memory for MLX).

### Engine API genericity (critical constraint)
- The core engine's public API must be model-agnostic from day one: accepts a model identifier, a weights path/location, and resolves which backend (MLX or CUDA) to load it through. No specific model is hardcoded into the runtime layer itself.
- The model catalog, hardware-requirement display, use-case categorization, and BM25 search stay entirely in Phase 2 per the existing roadmap dependency (Phase 2 depends on Phase 1). Phase 1 does not build any of the browser/catalog UI.
- User's stated reason: the model-selection/explorer experience is a key product feature. The backend must not be built in a way that requires rework once Phase 2 adds it.

### Reference/validation model for this phase's success criteria
- User's actual hardware: MacBook with M5 Pro, 64GB unified memory. Workstation `tux` (10.0.10.106): RTX 5090 (32GB GDDR7 VRAM, verified spec), 96GB system RAM.
- The RTX 5090 VRAM capacity is the binding constraint, system RAM is not usable as VRAM for GPU inference without CPU-offload, which is slower. At Q4 quantization (the reliability floor for tool-calling accuracy, harsher quantization degrades tool-call correctness), the practical ceiling on tux is roughly 30 to 32B dense models. A 70B-class model needs roughly 40GB or more at Q4, requiring CPU-offload or 3-bit quant, both undesirable.
- Validation model: **Qwen3.6-27B** (Apache 2.0, MLX and GGUF builds both available, fits comfortably under the RTX 5090 VRAM with headroom for a real context window, native tool-calling format). This is a validation artifact only. Since the engine API is model-agnostic, any compatible model can be substituted without touching the runtime.

### CUDA path validation during this phase
- SSH-driven directly from the execution session: `tux@10.0.10.106`, SSH key access already configured, no password prompt expected.
- Run hardware detection and inference validation directly on that box to verify the CUDA success criterion before the phase is considered done, rather than a manual step or deferring to CI.
- Saved as a standing reference (see leverframe-cuda-workstation-tux memory) since this machine will be needed again for later phases touching the CUDA path.

## Deferred Ideas

None surfaced outside phase boundary during this discussion.
