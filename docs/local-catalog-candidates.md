# Local model candidate evidence

Checked 2026-11-01 using publisher cards, pinned Hugging Face metadata and small configuration files. This research does not establish an accepted catalog. The research used no model weights, large tokenizer payloads, runtime installations or inference calls. These conservative text-only sets have not passed an offline load test and may contain unnecessary files or omit required files. LFS hashes and sizes come from the metadata API. We calculated other hashes from files no larger than 512 KiB. Verify bytes during installation.

All three model records report Apache-2.0. The 27B and 4B OptiQ cards describe mixed 4-bit and 8-bit quantization, while Coder Next is a 4-bit conversion. They are candidates for coding, coding and compaction respectively. Their quality, minimum memory, tool support and validated context remain unknown.

| Publisher model | Declared context | Validated local context |
| --- | --- | --- |
| [Qwen3-Coder-Next](https://huggingface.co/Qwen/Qwen3-Coder-Next) | 256K tokens | Unknown |
| [Qwen3.8-27B](https://huggingface.co/Qwen/Qwen3.8-27B) | 262,144 native, extensible to 1,000,000 | Unknown |
| [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) | 262,144 native, extensible to 1,010,000 | Unknown |

## Candidate artifact sets

Append each filename to its immutable base URL. Sizes are bytes. These sets conservatively include the index and generation configuration, and omit separate vision and MTP files pending an offline load test. The [27B conversion card](https://huggingface.co/mlx-community/Qwen3.8-27B-OptiQ-4bit) describes separated vision weights and stock mlx-lm text loading. Test the 4B artifact independently.

### mlx-community/Qwen3-Coder-Next-4bit

Revision: `7b9321eabb85ce79625cac3f61ea691e4ea984b5`. [Pinned metadata](https://huggingface.co/api/models/mlx-community/Qwen3-Coder-Next-4bit/revision/7b9321eabb85ce79625cac3f61ea691e4ea984b5?blobs=true). Base URL: https://huggingface.co/mlx-community/Qwen3-Coder-Next-4bit/resolve/7b9321eabb85ce79625cac3f61ea691e4ea984b5/

| Filename | Bytes | SHA-256 |
| --- | ---: | --- |
| `chat_template.jinja` | 6068 | `c79a833039a43602150cce0902403d6e376c50930c1b2a139b2964e1f0c322a0` |
| `config.json` | 22196 | `e8e2412abc210311363cad4396e12fc73e8142e81408ca241b2487cc80723a29` |
| `generation_config.json` | 214 | `37a3c1ef63516ca489c575f0db1c0405ddc0c3dbaca9ed987344c966c37aeef5` |
| `model-00001-of-00009.safetensors` | 5132893190 | `fb30a2722004cb427d9dc3b3583a9dc4f94badf68420393324e6ebee4432c96f` |
| `model-00002-of-00009.safetensors` | 5257948500 | `a6b2a95a4bb7463f74951a5565e2504e7f28fe78877bb966378003b0def69038` |
| `model-00003-of-00009.safetensors` | 5239714716 | `0b8e009bd09fb5994d4d188a61e28a90aead48a50d7e0983d3bd7fc3644553d3` |
| `model-00004-of-00009.safetensors` | 5261626153 | `6b34fd01a609db8bd4e445dcc0cc1ef5991550523b4df7e89f59c7d50343e321` |
| `model-00005-of-00009.safetensors` | 5257948651 | `f19b843ee11c5b4c8d56b2a5940033e81ec29013de75d944447754238344621b` |
| `model-00006-of-00009.safetensors` | 5239714662 | `37f9b2ff202e8d58239f1df6acc568cb08e10a324b57c19f21b38ce93608b8c0` |
| `model-00007-of-00009.safetensors` | 5257948739 | `78e4b432212f783db393bc643b9875918fc050c3d3c41a071bf9260449db356a` |
| `model-00008-of-00009.safetensors` | 5261626157 | `3841f088f9ceed8f4024e0c6496677af6b6a32047f762337b6d42232261cb3dc` |
| `model-00009-of-00009.safetensors` | 2934865732 | `933efe2e2f28f97b9b851839c43fca0d6742b26c9ff9df1fd0e427712246553c` |
| `model.safetensors.index.json` | 173450 | `4ab1fbfbc6e42a84c6b810745765db249350ab1df1d1cdb0c2841de89e8ca309` |
| `tokenizer.json` | 11422650 | `be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506` |
| `tokenizer_config.json` | 702 | `02222317d2b3586fe0676aaf7455a90fbe4b1e4f256b9f41fba3374357303ae2` |

### mlx-community/Qwen3.8-27B-OptiQ-4bit

Revision: `a95c2908fa8ca27cbf29ed86da9a658d14093b63`. [Pinned metadata](https://huggingface.co/api/models/mlx-community/Qwen3.8-27B-OptiQ-4bit/revision/a95c2908fa8ca27cbf29ed86da9a658d14093b63?blobs=true). Base URL: https://huggingface.co/mlx-community/Qwen3.8-27B-OptiQ-4bit/resolve/a95c2908fa8ca27cbf29ed86da9a658d14093b63/

| Filename | Bytes | SHA-256 |
| --- | ---: | --- |
| `chat_template.jinja` | 8952 | `c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041` |
| `config.json` | 109116 | `86fda9e23eb92e1e5f269abbcb947f33290d429c3eaa9b967734bfeb1bd7cef8` |
| `generation_config.json` | 202 | `e70c136c1b78ddc1fb0905bac8e733a4dc448d4f852a5dd75143fffc70be550e` |
| `model-00001-of-00004.safetensors` | 5324175241 | `d0dd221254f020175cf634ec2a471f2ef477e8c399fec8677cd7afdfef173b16` |
| `model-00002-of-00004.safetensors` | 5334249716 | `ac8ce5aab800be50306de5ac8039581983afeab0f86a6b2eec4257b1dee65ad0` |
| `model-00003-of-00004.safetensors` | 5361861644 | `95c5e2414c4e9dd0923b1cac8ec198d832fed3a1ec431d4d96ba4207f5efa366` |
| `model-00004-of-00004.safetensors` | 3405365120 | `990c5216374a1d6fe64c84abed76c07e510a8cf5440644df38f1c464f53226ee` |
| `model.safetensors.index.json` | 206922 | `d59ba1e684266d0b7453e295ab6b20341cee616954f73ca0ae5212350db4f668` |
| `tokenizer.json` | 19989325 | `06b9509352d2af50381ab2247e083b80d32d5c0aba91c272ca9ff729b6a0e523` |
| `tokenizer_config.json` | 1202 | `8f781f0d7369fb2532a77284368c2a5f9eccd6413a381dfa3795787e20ca4ca4` |

### mlx-community/Qwen3.5-4B-OptiQ-4bit

Revision: `4d4b423e71999777417dd587f429c9ad06e15dc0`. [Pinned metadata](https://huggingface.co/api/models/mlx-community/Qwen3.5-4B-OptiQ-4bit/revision/4d4b423e71999777417dd587f429c9ad06e15dc0?blobs=true). Base URL: https://huggingface.co/mlx-community/Qwen3.5-4B-OptiQ-4bit/resolve/4d4b423e71999777417dd587f429c9ad06e15dc0/

| Filename | Bytes | SHA-256 |
| --- | ---: | --- |
| `chat_template.jinja` | 7756 | `a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715` |
| `config.json` | 55537 | `3c79c138aed7cb789269aa3000db4a255d2d86f3e48091df897a30ffb588e3fe` |
| `generation_config.json` | 148 | `f2130efdf66df1834aa4f7a6e48752e88a8dff41965739c6ffb2bb26c841615e` |
| `model.safetensors` | 3269669552 | `5d59fea455202270c0f7f71a1902516b06457df5600c3182e1ff9163c33287c1` |
| `model.safetensors.index.json` | 99163 | `3265b866fd8e0ea2f38038c859217b1a381ec4e02156973649645909e491efae` |
| `tokenizer.json` | 19989343 | `87a7830d63fcf43bf241c3c5242e96e62dd3fdc29224ca26fed8ea333db72de4` |
| `tokenizer_config.json` | 1135 | `b2bed5e033438f09f22b0ce9522115b4807d9bbcc3b82bf23372cb74d93ed081` |

## Runtime and acceptance

All three tokenizer configurations declare `tool_parser_type: qwen3_coder` and ship a chat template. Preserve both, then test streaming, tool calls, tool results and argument parsing with the pinned runtime. The original [Coder Next card](https://huggingface.co/Qwen/Qwen3-Coder-Next) names `qwen3_coder` in its vLLM and SGLang examples. That does not establish MLX compatibility. The proposed MLX set omits the additional Coder Next parser scripts, which target other servers, pending verification.

The pinned [MLX LM 0.32.2 server](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/mlx_lm/server.py) accepts request-selected `model`, `draft_model` and `adapters`, then passes them to a provider that can load other paths. A managed helper must enforce one verified local model, reject or replace all three request selections, disable remote code and use offline safeguards. Test startup and adversarial requests with network access blocked. Loopback alone does not enforce the fixed model.

[MLX LM 0.32.2](https://pypi.org/project/mlx-lm/0.32.2/) and [MLX 0.32.2](https://pypi.org/project/mlx/0.32.2/#files) are candidate pins. The host has 64 GiB Apple Silicon, but default Python 3.15 lacks a listed MLX wheel for this version. Python 3.14 and 3.12 are available and still need installation and testing. The [MLX LM project metadata](https://github.com/ml-explore/mlx-lm/blob/v0.32.2/pyproject.toml) exposes CUDA 12 and 13 extras, and current [MLX installation documentation](https://ml-explore.github.io/mlx/build/html/install.html#cuda) describes CUDA support. The latter may describe a newer release. [vLLM 0.32.0](https://pypi.org/project/vllm/0.32.0/) is another candidate. Validate exact version, artifact compatibility, drivers, packaging and GPU behavior before selecting an NVIDIA backend.

Before catalog inclusion, explicitly install and hash the candidate set, prove offline startup and missing-file failure, establish safe memory headroom and peak load on a named host, and measure context limits and throughput. Validate compaction coverage and net token savings, plus coding streams and tool calls through the adapter. The user must run the required interactive Claude Code checks.

