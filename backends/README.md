# Prebuilt llama.cpp backends (Linux Electron)

Versioned **CUDA pack** for native `llama-server`. Not bundled in the AppImage by default. macOS Metal stays in [`mac/`](../mac/README.md).

```
backends/dist/linux-cuda/
  manifest.json
  bin/llama-server
  lib/*.so
```

Dev fallback: Electron looks here, then `~/.revolver/backends/`. Packaged AppImage does **not** bundle this dir — users install SKUs from Config → Manage runtimes. `LLAMA_SERVER_BIN` still wins.

## Packs

AppImage ships three downloadable llama.cpp SKUs (`runtimes/catalog.json`):

| Id | Backend | Source |
|---|---|---|
| `linux-cuda` | CUDA 12 fat binary (sm_70–sm_90) | Revolver-built, GitHub `runtimes-v1` |
| `linux-vulkan` | Vulkan | ggml-org ubuntu tarball, rehosted |
| `linux-cpu` | CPU (AVX2) | ggml-org ubuntu tarball, rehosted |

Pascal (sm_60/61) is not in the CUDA fat pack — use Vulkan. Host deps: NVIDIA driver for CUDA; Mesa + `video`/`render` + `/dev/dri` for Vulkan. Do not bundle `libcuda` or ICDs.

## Build (CUDA only)

Needs: CUDA toolkit (`nvcc`), cmake, ninja, gcc-12 (CUDA 12) or gcc-11 (CUDA 11.8).

```bash
./backends/build.sh linux-cuda              # host nvcc
./backends/build.sh linux-cuda --docker     # nvidia/cuda 12.4 devel image
```

Pin override: `LLAMA_CPP_REF=b10453 ./backends/build.sh linux-cuda`

Output: `backends/dist/linux-cuda/`

```bash
npm run install:llama-server          # copy pack → ~/.revolver/backends/
npm run start:native
```

`pack:native` does not copy `backends/dist`. Tar SKUs with `scripts/pack-linux-runtime.sh linux-cuda|linux-vulkan|linux-cpu` and upload onto `runtimes-v1`.

vLLM stays Docker. Compose never uses these packs.
