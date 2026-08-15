# Prebuilt llama.cpp backends (Linux Electron)

Versioned **CUDA packs** for native `llama-server`. Not bundled in the AppImage by default. macOS Metal stays in [`mac/`](../mac/README.md).

```
backends/dist/<pack-id>/
  manifest.json
  bin/llama-server
  lib/*.so
```

Electron looks here, then `~/.revolver/backends/`, then packaged `extraResources`. GPU compute cap from `nvidia-smi` picks the pack. `LLAMA_SERVER_BIN` still wins.

## Packs

| Id | Arch | GPUs |
|---|---|---|
| `linux-cuda-sm70` | sm_70 (Volta) | Tesla V100, TITAN V, Quadro GV100 |
| `linux-cuda-pascal` | sm_60 / sm_61 | P100, P40, GTX 10-series |

Official `llama.cpp` CUDA builds often omit Volta/Pascal device code. These packs compile **`-real` SASS only** (no PTX JIT stall on first prefill).

## Build

Needs: CUDA toolkit (`nvcc`), cmake, ninja, gcc-11 (CUDA 11.8) or a toolkit-compatible GCC.

```bash
./backends/build.sh sm70              # V100 / Volta
./backends/build.sh pascal            # P100 / GTX 10xx
./backends/build.sh sm70 --docker     # nvidia/cuda devel image, no host nvcc
```

Pin override: `LLAMA_CPP_REF=b10423 ./backends/build.sh sm70`

Output: `backends/dist/<pack-id>/`

```bash
npm run install:llama-server          # copy pack → ~/.revolver/backends/
npm run start:native
```

`pack:native` copies any built `backends/dist/*` into the app `extraResources`.

vLLM stays Docker. Compose never uses these packs.
