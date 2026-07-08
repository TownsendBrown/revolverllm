# Revolver — Architecture

Revolver is a **control plane** for local GGUF inference. It does not run models itself; it scans disk for GGUF files, estimates VRAM, persists server definitions, and drives **llama.cpp** processes (one container per server) via the host Docker daemon — or, on macOS, a native `llama-server` via a host agent. The React UI talks to a single backend surface that behaves identically whether hosted by Electron or Express.

---

## 1. Big picture

```
  ┌──────────────────────────────────────────────┐
  │  React UI (src/)                              │  Chat · Server · Config · Monitor
  └───────────────┬──────────────────────────────┘
                  │  RevolverApi  (one interface, two transports)
        ┌─────────┴──────────┐
        │                    │
   window.revolver      createWebApi()
   (Electron IPC)       (fetch /api/*)
        │                    │
  ┌─────▼─────┐        ┌─────▼─────────────┐
  │ electron/ │        │ server/index.ts   │  Express :3001 (loopback)
  │ main.ts   │        │ (nginx proxies)   │
  └─────┬─────┘        └─────┬─────────────┘
        │                    │
        └────────┬───────────┘
                 ▼
        server/handlers.ts        ← single business-logic surface
                 │
        server/serverManager.ts   ← per-server orchestration
                 │
        server/instanceRuntime.ts ← load/probe/log lifecycle per instance
                 │
     ┌───────────┴────────────┐
     ▼                        ▼
 containerUtils (docker CLI)  hostAgent (macOS Metal socket)
     │                        │
 revolver-server-<id>     native llama-server
 llama.cpp container      (Metal GPU)
```

Key idea: **`server/handlers.ts` is the one place business logic lives.** Both entrypoints (Electron IPC in `electron/main.ts`, Express routes in `server/index.ts`) are thin adapters that call the same handler functions. The frontend never knows which transport it got.

---

## 2. Frontend (`src/`)

- **Stack**: React 19 + Vite. TypeScript. Markdown chat with `react-markdown`, `remark-gfm`, `remark-math` + `rehype-katex` for math, and reasoning-trace rendering.
- **Entry**: `src/main.tsx` → `src/App.tsx`. `App` holds top-level state (config, models, GPU, server status) and renders four tab panels:
  - `components/ChatPanel.tsx` — multi-turn chat against a running server.
  - `components/ServerPanel.tsx` — load models, create/start/stop/delete server instances, tail logs.
  - `components/ConfigPanel.tsx` — paths and runtime defaults.
  - `components/MonitorPanel.tsx` — GPU/VRAM + load progress.
- **Transport selection** (`src/revolver.ts`):

```39:40:src/revolver.ts
export const api: RevolverApi =
  typeof window !== "undefined" && window.revolver ? window.revolver : createWebApi();
```

  If `window.revolver` exists (injected by the Electron preload), it uses IPC. Otherwise `createWebApi()` (`src/webApi.ts`) hits `/api/*` over `fetch`. Both implement the same `RevolverApi` type from `shared/types.ts`.
- **Streaming**: chat replies stream. Web mode uses SSE (`POST /api/conversations/:id/messages/stream`); Electron mode uses IPC `revolver:streamDelta` events. Both funnel deltas into the same `sendMessage` handler.
- **Polling**: `App` polls `getServerStatus` on an interval (faster while loading/creating) to reflect container lifecycle.

---

## 3. Backend surface (`server/`)

### `handlers.ts` — the API contract
One object of async functions: config, GPU/monitor, model catalog, VRAM estimate + guardrails, server CRUD (`createServer`/`startServer`/`stopServer`/`deleteServer`), conversations CRUD, and `sendMessage`/`chat`. Errors prefixed `GUARDRAIL_BLOCKED` map to HTTP 409.

### `index.ts` — Express host
Maps routes to handlers in a table, plus bespoke routes for status, SSE streaming, and conversation sub-resources. On boot calls `serverManager.reconcile()` to adopt already-running containers, then listens on `PORT` (default 3001), bound `0.0.0.0` inside the container (compose publishes it to `127.0.0.1` only).

### `serverManager.ts` — orchestration
Keeps a `Map<serverId, InstanceRuntime>`. Resolves model paths, clamps context length, computes GPU device/mode + effective GPU layers, persists a `ServerDefinition`, and starts an `InstanceRuntime`. `overview()` aggregates all instances into the `ServersOverview` the UI consumes. `inferTarget()` picks the host/port/apiKey for a chat request (errors if multiple servers run and none is selected).

### `instanceRuntime.ts` — per-instance lifecycle
Owns one llama-server instance:
1. Validates model path, computes GPU layers, decides KV-cache quant → Flash-Attention.
2. `writeLoadEnv()` writes `llama-load-<id>.env` into the shared config volume.
3. `restartServerRuntime()` (re)starts the container/process.
4. `waitForModelReady()` polls `/health` + `/v1/models` and tails logs until "model loaded"/"server listening" (5-min deadline).
5. Tracks state, load progress, tokens/sec, and log buffers; exposes `status()`.
6. `adopt()` reconstructs live state from a running container on boot (only marks loaded if `/health` is ready).

### `serverRuntime.ts` — runtime dispatch
Thin router: **Metal backend → `hostAgent` socket calls**; everything else → **`containerUtils` docker CLI**. Same interface (`ensure`/`restart`/`stop`/`inspect`/`logs`/`startedAt`/`remove`) for both.

### `containerUtils.ts` — Docker driver
Shells out to `docker` (`execFile`). Picks the image per backend:

```
  cpu    → ghcr.io/ggml-org/llama.cpp:server
  cuda   → :server-cuda      rocm → :server-rocm      vulkan → :server-vulkan
```

Containers are named `revolver-server-<id>`, labeled `revolver.managed=1` (so the boot reconciler can find them), publish `hostPort:8080`, mount the models dir and a shared **config volume**, and run an **embedded entrypoint script** (`ENTRYPOINT_SCRIPT`) injected via that volume — no Docker build context needed. The entrypoint reads the per-server `.env`, builds `llama-server` flags, and `exec`s the binary (or sleeps idle if no model). GPU wiring (`--gpus device=…`, `CUDA_VISIBLE_DEVICES`, ROCm devices, Vulkan `/dev/dri`) is handled in `gpuRunArgs`, with host→container GPU index renumbering.

### `hostAgent.ts` + `mac/` — macOS Metal path
Docker on macOS can't reach the Metal GPU, so Metal servers run a **native `llama-server`** on the host, supervised by a **host agent** (`mac/host-agent/`) that speaks a small protocol over a Unix socket. The backend calls it through `hostAgent`/`serverRuntime`; from Revolver's perspective it's just another runtime target. See `mac/README.md`.

### `openPathDispatch.ts` / `hostOpenAgent.ts`
"Open folder/file" support. In Electron it uses the native opener; in Docker it dispatches to a host open-agent (`host/open-agent/`) since the container can't open host GUI apps.

---

## 4. Shared logic (`electron/lib/`)

Despite the folder name, these modules are used by **both** Electron and the Express backend (imported by `server/handlers.ts` etc.):

- `models.ts`, `ggufMeta.ts`, `ggufMetadata.ts` — scan disk (incl. Hugging Face hub layouts), read GGUF metadata, build the model catalog.
- `vram.ts` — VRAM estimation, `evaluateGuardrails`, `effectiveGpuLayers`.
- `contextLength.ts` — clamp/derive context length from model + config.
- `chatDb.ts` — SQLite (`better-sqlite3`) store for conversations/messages.
- `chatService.ts`, `chatInfer.ts`, `chatDb.ts` — conversation persistence + streaming inference against the running llama-server (OpenAI-compatible endpoints).
- `config.ts`, `paths.ts`, `runtimeConfig.ts`, `serverConfig.ts`, `serversStore.ts`, `localMeta.ts` — configuration + persistence.
- `gpu.ts`, `monitor.ts`, `systemMonitor.ts`, `serverLogs.ts`, `serverLogParse.ts` — telemetry and log parsing (load phases, tokens/sec).

`shared/types.ts` defines the cross-cutting types (`RevolverApi`, `ServerDefinition`, `ServerInstanceStatus`, etc.); `shared/openPath.ts` holds host-path resolution helpers.

---

## 5. Two deployment modes

### Electron (desktop)
`electron/main.ts` boots the app, sets `REVOLVER_DOCKER=1`, wires every `revolver:*` IPC channel to a handler, and creates the `BrowserWindow`. `electron/preload.ts` exposes `window.revolver`. Paths come from `config.json`. The main process talks to the **host Docker daemon** directly (or the Metal host agent). Packaged via `electron-builder` (AppImage + deb).

### Docker Compose (web)
`docker-compose.yml`: an **nginx frontend** (`docker/frontend/`) serves the static SPA on `FRONTEND_PORT` (8080) and reverse-proxies `/api/*` to the **Node backend** (`docker/backend/`) on `127.0.0.1:BACKEND_PORT` (3001). The backend mounts the **host Docker socket** to spawn llama.cpp containers on the host, plus volumes for models, runtime data, and the shared `llama-config` volume (holds the entrypoint + per-server env). `docker-compose.gpu.yml` overlays NVIDIA GPU access; `docker-compose.mac.yml` + `mac/` wires the Metal host agent.

In both modes: **models stay on disk**, bind-mounted into llama containers. Revolver only manages configuration and orchestration.

---

## 6. Request flows

**Load a model / create a server**
```
UI → api.createServer → handlers.createServer
   → computeEstimate + guardrails (block if over budget unless force)
   → serverManager.createAndStart → new ServerDefinition (persisted)
   → InstanceRuntime.startLoad → writeLoadEnv → docker run/restart
   → waitForModelReady (poll /health, tail logs) → status: ready
```

**Chat (streaming)**
```
UI → sendMessage(onDelta) → SSE or IPC stream
   → handlers.sendMessage → ensureModelForRequest (+ optional JIT load)
   → serverManager.inferTarget (host/port/apiKey)
   → chatService.sendMessage → chatInfer.inferChatStream → llama-server /v1/chat/completions
   → deltas streamed back → persisted in SQLite
```

**Boot reconcile**
```
backend start → serverManager.reconcile
   → for each ServerDefinition: InstanceRuntime.adopt
   → inspect container/agent; if /health ready, restore "loaded" state
```

---

## 7. Where to look

| Concern | File(s) |
|--------|---------|
| API contract | `server/handlers.ts`, `shared/types.ts` |
| HTTP routes | `server/index.ts` |
| Electron IPC | `electron/main.ts`, `electron/preload.ts` |
| Orchestration | `server/serverManager.ts`, `server/instanceRuntime.ts` |
| Runtime dispatch | `server/serverRuntime.ts` |
| Docker driver | `server/containerUtils.ts` |
| macOS Metal | `server/hostAgent.ts`, `mac/` |
| Model scan / metadata | `electron/lib/models.ts`, `electron/lib/ggufMeta*.ts` |
| VRAM / guardrails | `electron/lib/vram.ts` |
| Chat persistence + inference | `electron/lib/chatDb.ts`, `chatService.ts`, `chatInfer.ts` |
| Frontend shell | `src/App.tsx`, `src/components/*` |
| Transport | `src/revolver.ts`, `src/webApi.ts` |
| Deploy | `docker-compose*.yml`, `docker/`, `package.json` scripts |
```
