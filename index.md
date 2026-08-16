# Revolver — Architecture

Revolver is a **control plane** for local inference. It does not run models itself; it scans disk for GGUF / Hugging Face weight trees, estimates VRAM, persists server definitions, and drives **one inference process per server** — a Docker container (`llama.cpp` or vLLM) or a native host `llama-server`. The React UI talks to a single backend surface that behaves identically whether hosted by Electron or Express. An OpenAI-compatible **gateway** on a fixed port routes clients (Cline, etc.) to the right running server by model id.

---

## 1. Big picture

```
  ┌──────────────────────────────────────────────────┐
  │  React UI (src/)                                  │
  │  Chat · Server · Config · Monitor · Benchmarks    │
  └────────────────────┬─────────────────────────────┘
                       │  RevolverApi  (one interface, two transports)
             ┌─────────┴──────────┐
             │                    │
        window.revolver      createWebApi()
        (Electron IPC)       (fetch /api/*)
             │                    │
       ┌─────▼─────┐        ┌─────▼─────────────┐
       │ electron/ │        │ server/index.ts   │  Express :3001
       │ main.ts   │        │ (nginx proxies)   │
       └─────┬─────┘        └─────┬─────────────┘
             │                    │
             └────────┬───────────┘
                      ▼
             server/handlers.ts          ← single business-logic surface
                      │
             server/serverManager.ts     ← Map<serverId, InstanceRuntime>
                      │
             server/instanceRuntime.ts   ← load / probe / logs / GPU lease
                      │
             engines/*                   ← llamacpp | vllm | vllm-legacy
                      │                    (container spec, load env, VRAM)
             server/serverRuntime.ts     ← docker | native | metal
           ┌──────────┼──────────┐
           ▼          ▼          ▼
     containerUtils  nativeSupervisor  hostAgent (macOS Metal)
     docker CLI      spawn llama-server   Unix socket / TCP
     revolver-server-<id>

  openaiGateway.ts  :8081  ──►  /v1/chat/completions  (route by model)
```

Key idea: **`server/handlers.ts` is the one place business logic lives.** Both entrypoints (Electron IPC in `electron/main.ts`, Express routes in `server/index.ts`) are thin adapters that call the same handler functions. The frontend never knows which transport it got.

A second axis is **engine vs runtime vs backend**:

| Axis | Meaning | Values |
|------|---------|--------|
| **Engine** | What implementation runs the model | `llamacpp`, `vllm`, `vllm-legacy` |
| **Runtime** | How that process is supervised | `docker`, `native` (host process), `metal` (macOS host-agent) |
| **Backend** | GPU/CPU ISA | `cuda`, `rocm`, `vulkan`, `cpu`, `metal` |

Engines never start processes. `serverRuntime.ts` never knows GGUF vs safetensors. GPU device assignment and exclusive leases (`gpuClaims.ts`) sit above both.

---

## 2. Frontend (`src/`)

- **Stack**: React 19 + Vite. TypeScript. Markdown chat with `react-markdown`, `remark-gfm`, `remark-math` + `rehype-katex` for math, and reasoning-trace rendering.
- **Entry**: `src/main.tsx` → `src/App.tsx`. `App` holds top-level state (config, models, GPU, server status, platform capabilities) and renders five tab panels:
  - `components/ChatPanel.tsx` — multi-turn chat against a running server; thinking toggle; conversation URL sync.
  - `components/ServerPanel.tsx` — create/start/stop/delete instances, pick engine/runtime/GPU, tail logs.
  - `components/ConfigPanel.tsx` — paths, gateway, JIT/TTL flags, runtime defaults.
  - `components/MonitorPanel.tsx` — GPU/VRAM + system snapshot.
  - `components/BenchmarkPanel.tsx` — start/cancel/score local eval suites.
- **Transport selection** (`src/revolver.ts`):

```39:40:src/revolver.ts
export const api: RevolverApi =
  typeof window !== "undefined" && window.revolver ? window.revolver : createWebApi();
```

  If `window.revolver` exists (injected by the Electron preload), it uses IPC. Otherwise `createWebApi()` (`src/webApi.ts`) hits `/api/*` over `fetch`. Both implement the same `RevolverApi` type from `shared/types.ts`.
- **Streaming**: chat replies stream. Web mode uses SSE (`POST /api/conversations/:id/messages/stream`); Electron mode uses IPC `revolver:streamDelta` events. Both funnel deltas into the same `sendMessage` handler.
- **Polling**: `App` polls `getServerStatus` on an interval (500 ms while loading, 1500 ms otherwise). Server / Chat / Monitor / Benchmark panels also poll their own resources.

---

## 3. Backend surface (`server/`)

### `handlers.ts` — the API contract
One object of async functions: config, platform capabilities, GPU/monitor, model catalog, engine list, VRAM estimate + guardrails, server CRUD (`createServer`/`startServer`/`stopServer`/`deleteServer`), conversations CRUD, `sendMessage`/`chat`, and the benchmark runner. Errors prefixed `GUARDRAIL_BLOCKED` map to HTTP 409.

Legacy `loadModel` / `loadModelFromPath` still exist; they create a server with **hardcoded `backend: "cuda"`** and empty `gpuDevices`. The UI path is `createServer`.

### `index.ts` — Express host
Maps routes to handlers in a table, plus bespoke routes for status, SSE streaming, conversation sub-resources, and `/api/benchmarks/*`. On boot calls `serverManager.reconcile()` to adopt already-running containers/processes, then starts the OpenAI gateway, then listens on `PORT` (default 3001), bound `0.0.0.0` inside the container (compose publishes it to `127.0.0.1` only). CORS is currently `cors()` with no origin restriction.

### `serverManager.ts` — orchestration
Keeps a `Map<serverId, InstanceRuntime>`. Resolves model path + engine, validates engine/backend/native, clamps context length, computes GPU mode, persists a `ServerDefinition` (`electron/lib/serversStore.ts` → `servers.json`), and starts an `InstanceRuntime`. `overview()` aggregates all instances into the `ServersOverview` the UI consumes. `inferTarget()` picks host/port/apiKey/upstream model for a chat request (errors if multiple servers run and none is selected). `resolveGateway()` builds the OpenAI model list + route.

### `instanceRuntime.ts` — per-instance lifecycle
Owns one inference instance:
1. Validates model path, claims GPUs (`gpuClaims.ts` exclusive lease unless `force`), computes GPU layers, writes engine load-env.
2. `writeLoadEnv()` writes the per-server `.env` into the shared config volume (or native config dir).
3. `restartServerRuntime()` (re)starts the container/process.
4. `waitForModelReady()` uses the engine's `readiness()` spec (log markers + optional `/health` + `/v1/models`) with a per-engine deadline (llama.cpp: 5 min).
5. Probes `/props` for chat-template reasoning support and `n_ctx`.
6. Tracks state, load progress, tokens/sec, and log buffers; exposes `status()`.
7. `adopt()` reconstructs live state from a running container/process on boot (only marks loaded if `/health` or `/v1/models` is ready) and force-claims GPUs.

### `serverRuntime.ts` — runtime dispatch
Thin router:

- **Metal backend** → `hostAgent` socket calls (always host process; ignores `runtime`).
- **`runtime: "native"`** → `nativeSupervisor` (`spawn` of host `llama-server`). Compose (`REVOLVER_COMPOSE=1`) refuses this.
- **else** → `containerUtils` docker CLI.

Same interface (`ensure` / `restart` / `stop` / `inspect` / `logs` / `startedAt` / `remove`) for all three.

### `containerUtils.ts` — Docker driver
Shells out to `docker` (`execFile`). Image comes from the engine's `containerSpec()`, not a hardcoded llama.cpp map. Containers are named `revolver-server-<id>`, labeled `revolver.managed=1` (boot reconciler), publish `hostPort:<engine containerPort>`, mount the models dir and a shared **config volume**, and run an **embedded entrypoint script** injected via that volume — no Docker build context needed. GPU wiring (`--gpus device=…`, `CUDA_VISIBLE_DEVICES`, ROCm devices, Vulkan `/dev/dri`) is handled in `gpuRunArgs`, with host→container GPU index renumbering for Docker.

### `nativeSupervisor.ts` + `llamaServerBin.ts`
Host-process llama.cpp. Resolves `LLAMA_SERVER_BIN` or a staged CUDA pack (`backends/`, `shared/nativeBackends.ts`). Reuses the llama.cpp entrypoint script via `/bin/sh`. Exclusive GPU leases use **host** indices (no Docker remapping). `test:native` covers this with `scripts/mock-llama-server.mjs`.

### `hostAgent.ts` + `mac/` — macOS Metal path
Docker on macOS can't reach the Metal GPU, so Metal servers run a **native `llama-server`** on the host, supervised by a **host agent** (`mac/host-agent/`) that speaks a small protocol over a Unix socket (or TCP from Compose via `host.docker.internal:9743`). See `mac/README.md`.

### `openaiGateway.ts` + `gatewayRouting.ts`
Separate Express app (default `:8081`). Optional bearer key (`gatewayApiKey`). Proxies `/v1/models`, `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` to the matching running server. Model ids are aliases of `modelId`, server name, GGUF basename, etc.

### `openPathDispatch.ts` / `hostOpenAgent.ts`
"Open folder/file" support. In Electron it uses the native opener; in Docker it dispatches to a host open-agent (`host/open-agent/`) since the container can't open host GUI apps.

### Benchmarks (`benchmarkRunner.ts` + `shared/benchmarks/`)
In-process suites: website-generation, platformer-game, frontend-design, performance, context-retrieval, agency (MiniCorp tool-use sim). Docker harnesses for LiveCodeBench and EvalPlus (`docker/livecodebench`, `docker/evalplus`, compose profile `bench`). Runs persist as JSON under the data dir; artifacts served at `/api/benchmarks/runs/:runId/artifacts/...`.

---

## 4. Engines (`engines/`)

`engines/registry.ts` holds `llamacpp` (default), `vllm`, `vllm-legacy`. Each `InferenceEngine` implements:

- `validateModel` / `supportsBackend`
- `containerSpec` — image, entrypoint script, mounts, shm/ipc
- `buildLoadEnv` — per-server env file
- `readiness` — log markers, error markers, timeout
- `memory.estimate` — VRAM / KV for guardrails

| Engine | Formats | Sources | Native | Notes |
|--------|---------|---------|--------|-------|
| `llamacpp` | GGUF | local | yes | CPU/CUDA/ROCm/Vulkan/Metal |
| `vllm` | safetensors, AWQ, GPTQ, GGUF | local + Hugging Face repo id | no | CUDA, tensor parallel; GGUF needs a mapped tokenizer |
| `vllm-legacy` | safetensors | local + Hugging Face | no | vLLM 0.9.x for Pascal (P100/P40); architecture denylist |

The UI renders `configFields` dynamically (vLLM `gpu_memory_utilization`, `dtype`, `enforce_eager`, …). llama.cpp knobs stay on `ServerDefinition` (`nGpuLayers`, `kvCacheDtype`, `contextLength`) for backward compatibility.

---

## 5. Shared logic (`electron/lib/`)

Despite the folder name, these modules are used by **both** Electron and the Express backend (imported by `server/handlers.ts` etc.):

- `models.ts`, `ggufMeta.ts`, `ggufMetadata.ts`, `hfModels.ts` — scan disk (GGUF, Hugging Face hub layouts, local safetensors trees), read metadata, build the model catalog with `compatibleEngines`.
- `vram.ts` — VRAM estimation helpers + `evaluateGuardrails` / `effectiveGpuLayers`. Engine-specific math lives in `engines/*/memory.ts`.
- `contextLength.ts` — clamp/derive context length from model + config.
- `chatDb.ts` — SQLite (`better-sqlite3`) store for conversations/messages.
- `chatService.ts`, `chatInfer.ts` — conversation persistence + streaming inference against the running server (OpenAI-compatible endpoints; Harmony / `enable_thinking` split).
- `config.ts`, `paths.ts`, `runtimeConfig.ts`, `serverConfig.ts`, `serversStore.ts`, `localMeta.ts` — configuration + persistence.
- `gpu.ts`, `monitor.ts`, `systemMonitor.ts`, `serverLogs.ts`, `serverLogParse.ts`, `generation.ts` — telemetry, log parsing (load phases, tokens/sec), in-flight generation tracker.

`shared/types.ts` defines the cross-cutting types (`RevolverApi`, `ServerDefinition`, `EngineId`, `ServerRuntimeMode`, …). `shared/gpuDevices.ts` maps UI GPU indices ↔ CUDA/HIP/Vulkan runtime indices. `shared/runtimeMode.ts` resolves docker/native/metal and `CUDA_VISIBLE_DEVICES` remapping. `shared/reasoning.ts` handles thinking traces.

---

## 6. Two deployment modes

### Electron (desktop)
`electron/main.ts` boots the app, applies Docker env + packaged native default, wires every `revolver:*` IPC channel to a handler, starts the OpenAI gateway, and creates the `BrowserWindow`. `electron/preload.ts` exposes `window.revolver`. Paths come from `config.json`. The main process talks to the **host Docker daemon** and/or spawns **native `llama-server`**. Packaged via `electron-builder` (Linux AppImage + deb). `pack:native` sets `revolverRuntime=native` in extraMetadata.

### Docker Compose (web)
`docker-compose.yml`: an **nginx frontend** (`docker/frontend/`) serves the static SPA on `FRONTEND_PORT` (8080) and reverse-proxies `/api/*` to the **Node backend** (`docker/backend/`) on `127.0.0.1:BACKEND_PORT` (3001). Compose also publishes the gateway on `127.0.0.1:8081`. The backend mounts the **host Docker socket** to spawn inference containers on the host, plus volumes for models, runtime data, and the shared `llama-config` volume (entrypoint + per-server env). Native spawn is disabled (`REVOLVER_COMPOSE=1`). `docker-compose.gpu.yml` overlays NVIDIA GPU access; `docker-compose.mac.yml` + `mac/` wires the Metal host agent.

In both modes: **models stay on disk**, bind-mounted into containers. Revolver only manages configuration and orchestration.

---

## 7. Request flows

**Load a model / create a server**
```
UI → api.createServer → handlers.createServer
   → validate GPU selection + engine compatibility
   → computeEstimate + guardrails (block if over budget unless force)
   → serverManager.createAndStart → ServerDefinition (servers.json)
   → InstanceRuntime.startLoad → claimGpus → writeLoadEnv
   → docker run / native spawn / host-agent restart
   → waitForModelReady (engine readiness spec) → status: ready
```

**Chat (streaming)**
```
UI → sendMessage(onDelta) → SSE or IPC stream
   → handlers.sendMessage → ensureModelForRequest (+ optional JIT load)
   → serverManager.inferTarget (host/port/apiKey/upstream model)
   → chatService.sendMessage → chatInfer.inferChatStream
   → llama-server or vLLM /v1/chat/completions
   → deltas streamed back → persisted in SQLite
```

**OpenAI gateway**
```
client → :8081 /v1/chat/completions { model }
   → gatewayRouting.resolve → running InstanceRuntime
   → proxy to http://host:hostPort/v1/chat/completions
```

**Boot reconcile**
```
backend start → serverManager.reconcile
   → for each ServerDefinition: InstanceRuntime.adopt
   → inspect container/native/agent; if ready, restore loaded + claimGpus(force)
   → startOpenAiGateway
```

**Benchmark run**
```
UI → startBenchmarkRun → benchmarkRunner
   → inferChatStream (generation tests) or Docker harness (LCB / EvalPlus)
   → evaluators + optional human score → data/benchmarks/runs/<id>.json
```

---

## 8. Where to look

| Concern | File(s) |
|--------|---------|
| API contract | `server/handlers.ts`, `shared/types.ts` |
| HTTP routes | `server/index.ts` |
| Electron IPC | `electron/main.ts`, `electron/preload.ts` |
| Orchestration | `server/serverManager.ts`, `server/instanceRuntime.ts` |
| Runtime dispatch | `server/serverRuntime.ts` |
| Docker driver | `server/containerUtils.ts` |
| Native llama-server | `server/nativeSupervisor.ts`, `server/llamaServerBin.ts`, `backends/` |
| macOS Metal | `server/hostAgent.ts`, `mac/` |
| GPU leases | `server/gpuClaims.ts`, `shared/gpuDevices.ts` |
| Engines | `engines/registry.ts`, `engines/llamacpp/`, `engines/vllm/`, `engines/vllm-legacy/` |
| OpenAI gateway | `server/openaiGateway.ts`, `server/gatewayRouting.ts` |
| Model scan / metadata | `electron/lib/models.ts`, `electron/lib/ggufMeta*.ts`, `electron/lib/hfModels.ts` |
| VRAM / guardrails | `electron/lib/vram.ts`, `engines/*/memory.ts` |
| Chat persistence + inference | `electron/lib/chatDb.ts`, `chatService.ts`, `chatInfer.ts` |
| Benchmarks | `server/benchmarkRunner.ts`, `shared/benchmarks/`, `src/components/BenchmarkPanel.tsx` |
| Frontend shell | `src/App.tsx`, `src/components/*` |
| Transport | `src/revolver.ts`, `src/webApi.ts` |
| Deploy | `docker-compose*.yml`, `docker/`, `package.json` scripts |

---

## Suggested improvements

Grounded in current code. Grouped by effort, not wish-list.

### Quick (hours)

- **Honor JIT / TTL / auto-evict.** `ServerConfig` already has `justInTimeModelLoading`, `autoEvict`, `jitModelTTL`. `serverManager.overview()` and `handlers.getServerStatus` hardcode `jit: { enabled: false, … }`. `LoadedModelState.jitLoaded` / `ttlExpiresAt` are always null. Config panel exposes knobs that do almost nothing except the one-shot JIT path in `ensureModelForRequest`.
- **Stop hardcoding CUDA on legacy load.** `handlers.loadModel` / `loadModelFromPath` always pass `backend: "cuda"` and `gpuDevices: []`. JIT fallback in `ensureModelForRequest` does the same. Use last-used backend from `runtimeConfig` / `getPlatform().defaultRuntime`.
- **Fix `/health`.** Express healthcheck always returns `{ ok: true, docker: true }` even when the daemon is down. Compose uses this for `service_healthy`. Probe `dockerHealth()` (and native/gateway) and fail accordingly.
- **Web `pickModelFile`.** Electron IPC opens a GGUF dialog; `handlers.pickModelFile` and `webApi.pickModelFile` return `null`. Either hide the control in web mode or add a path text field.
- **Abort inference when the SSE client drops.** `POST /api/conversations/:id/messages/stream` sets `clientClosed` and stops writing, but `handlers.sendMessage` keeps running against llama-server. Thread `AbortSignal` from `req` close into `inferChatStream` (the type already has `signal?`). Same for gateway proxy: abort check is only at request start (`req.socket.destroyed`).
- **Path-traverse guard on benchmark artifacts.** `readArtifact(runId, relPath)` `join`s user-controlled `relPath` with no `..` / absolute-path check.
- **Linux-only Docker warning.** `App.tsx` warns `Docker is not available` only when `platform.os === "linux"`. Native runtime exists; macOS Compose-without-agent is the more common miss.
- **Singleton `generationTracker`.** One global in-flight generation. Concurrent chats on two servers clobber each other's Monitor/Server "generating" state. Key by `serverId`.

### Medium (days–week)

- **Rename `electron/lib/` → `lib/` (or `core/`).** Every server/engine module imports "electron" code. New contributors assume it is desktop-only. Mechanical move; update tsconfig paths.
- **Replace status polling with a push channel.** `App` polls every 0.5–1.5 s; ServerPanel (800 ms), ChatPanel, MonitorPanel, BenchmarkPanel all poll independently. A single SSE/IPC `status` stream would cut Docker `logs`/`inspect` chatter and make load progress smoother.
- **Wire SSE abort + generation cancel in the UI.** Chat already has `AbortController` for the fetch; Electron IPC stream has no cancel. Stop button should kill the upstream `/v1/chat/completions`.
- **GPU claim persistence / reconcile ordering.** Claims live in a process-local `Map`. Adopt uses `force: true`, so a crash-restart never detects overlap that `force` created. Reconcile should rebuild occupancy from adopted processes first, then refuse new loads that collide.
- **Engine-aware VRAM for vLLM.** llama.cpp estimates are relatively detailed (weights + KV + mmproj). vLLM path is coarser (`gpu_memory_utilization` fraction). Wrong numbers → guardrails too timid or too aggressive on multi-GPU tensor parallel.
- **Catalog refresh without full rescan.** `getCatalog` walks hub + downloads + GGUF trees on every `getModels()`. Large HF caches hitch the UI. Incremental watch (`fs.watch`) or an index with mtime.
- **Control-plane auth.** Express `cors()` is wide open; `/api/*` has no bearer check. Fine while compose binds 127.0.0.1. One published `BACKEND_PORT` and anyone on the LAN can spawn containers via the mounted docker.sock. Mirror `gatewayApiKey` (or bind the API to loopback inside the container network only — it already listens `0.0.0.0`).
- **Schema version on `servers.json` / chat.db.** `normalizeDefinition` silently fills `engine`/`apiKey`. No version field; a future field rename will be guesswork. Add `schemaVersion` and a one-way migrate.
- **Frontend tests.** Unit coverage is Node-side (`tsx --test`). No component tests, no SSE contract test for `webApi.ts`. A few `RevolverApi` mock tests around ChatPanel send/abort would lock the dual-transport invariant.
- **ESLint + format in CI.** `package.json` has typecheck + unit + pack smoke. No lint script; stray `eslint-disable` comments in `useStickyScroll.ts` with no eslint config.

### Deep (architecture / product)

- **Unify host process supervision.** Metal host-agent (`mac/host-agent/src/supervisor.ts`) and `nativeSupervisor.ts` both spawn `/bin/sh` + llama.cpp entrypoint, both `lsof` ports, both buffer logs. One supervisor with a "how do I talk to it" adapter (in-process vs Unix socket) would drop a whole protocol. Metal stays special only for "must run on the Mac host while Compose is in Linux VM".
- **Dockerode (or docker socket HTTP) instead of `execFile("docker", …)`.** CLI is parse-fragile, timeout-awkward, and requires the docker binary in the backend image — not just the socket. SDK gives structured inspect, log follow, and pull progress for the UI.
- **Drop or finish the legacy load API.** `loadModel` / `unloadModel` / `pickModelFile` predate multi-server + engines. UI uses `createServer`. Keeping both means JIT and "Load" shortcuts diverge from the wizard (engine, runtime, GPU).
- **Windows as a first-class runtime.** `win32` appears in path/open helpers and `PlatformCapabilities.os`. No electron-builder Windows target, no CUDA pack, `lsof`/`fuser` in native supervisor. Either document "Linux + macOS only" or add `win32` pack + `Get-NetTCPConnection` port kill.
- **macOS / Windows Electron packages.** `pack` is Linux AppImage+deb only. Metal users run `npm run start:macos` from source. Signing/notarization is the real work, not the Vite build.
- **In-app Hugging Face download.** Catalog already understands hub layouts and vLLM `huggingface` source (repo id + `HF_TOKEN`). There is no download manager; users copy trees into `hubModelsDir` by hand. A job queue with progress would make vLLM usable without CLI.
- **Chat: tools, RAG, export.** Gateway already proxies `/v1/embeddings`. Chat UI is single-assistant text + reasoning. Function-calling, retrieval against a local embed server, and conversation export/search are the gap vs using the gateway from an external client.
- **Multi-machine control plane.** One Node process, one docker.sock, GPUs on that host. Next step is a worker agent on each box (reuse host-agent protocol) so the UI can place a server on "machine B, GPU 1".
- **More engines, same registry.** TensorRT-LLM / MLX / llama.cpp RPC are additive if they stay behind `InferenceEngine`. MLX would be the native-mac counterpart to CUDA packs. Keep `containerSpec` optional for native-only engines.
- **Observability.** Logs are ring buffers in memory + `docker logs`. No structured request log, no Prometheus, no per-server token accounting beyond last TPS. Gateway is the natural place to emit `model`, `serverId`, tokens, TTFT.
- **Hardening docker.sock.** Backend container is effectively root on the host daemon. Rootless docker, a narrow wrapper binary that only allows `revolver-server-*` names, or a dedicated spawn agent would shrink the blast radius of a compromised control plane.

Priority if doing a short sequence: abort-on-disconnect + `/health` + JIT honesty, then `electron/lib` rename + status push, then supervisor unification.
