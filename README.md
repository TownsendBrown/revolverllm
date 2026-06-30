```text
            W@$$$$$$$$$$$$@_
         uB`                f&'
      IB)  p0fY*`      xhrnW- .*z
     )u  /"     .O   .J      %   B
    {z   8       h   L       ;~  .B
   _Y    o       B   [i      Y'   .%       .----------------.  .----------------.  .----------------.  .----------------.  .----------------.  .----------------.  .----------------.  .----------------.
  -X      Ct.  -d     lo'  ,%.      B      | .--------------. || .--------------. || .--------------. || .--------------. || .--------------. || .--------------. || .--------------. || .--------------. |
 ]u                                  $      | |  _______     | || |  _________   | || | ____   ____  | || |     ____     | || |   _____      | || | ____   ____  | || |  _________   | || |  _______     | |
]n  >%j(Wx                   'MX{hO   @      | | |_   __ \    | || | |_   ___  |  | || ||_  _| |_  _| | || |   .'    `.   | || |  |_   _|     | || ||_  _| |_  _| | || | |_   ___  |  | || | |_   __ \    | |
m. B      b                 w.     )< k      | |   | |__) |   | || |   | |_  \_|  | || |  \ \   / /   | || |  /  .--.  \  | || |    | |       | || |  \ \   / /   | || |   | |_  \_|  | || |   | |__) |   | |
m.-^       h               'u       & k      | |   |  __ /    | || |   |  _|  _   | || |   \ \ / /    | || |  | |    | |  | || |    | |   _   | || |   \ \ / /    | || |   |  _|  _   | || |   |  __ /    | |
m..c      "I                o       C k      | |  _| |  \ \_  | || |  _| |___/ |  | || |    \ ' /     | || |  \  `--'  /  | || |   _| |__/ |  | || |    \ ' /     | || |  _| |___/ |  | || |  _| |  \ \_  | |
O^  %`   k:                  ai   Yt  a      | | |____| |___| | || | |_________|  | || |     \_/      | || |   `.____.'   | || |  |________|  | || |     \_/      | || | |_________|  | || | |____| |___| | |
 M'                                  w;      | |              | || |              | || |              | || |              | || |              | || |              | || |              | || |              | |
  W.       Mo-O&       u@}f@[       mI      | '--------------' || '--------------' || '--------------' || '--------------' || '--------------' || '--------------' || '--------------' || '--------------' |
   %     x:     'O   .J      &     wI       '----------------'  '----------------'  '----------------'  '----------------'  '----------------'  '----------------'  '----------------'  '----------------'
    B    &       a   L       :~   qI
     B.  *       B   1l      X'  b,
      dw  vc   )q     Io   `%. :@"
        :B{                 .hY
           u8}}}}}}}}}}}}}/8'
```

# Revolver

Revolver is a local model manager for **GGUF** files. Point it at a models directory, pick a checkpoint, and it starts a **llama.cpp** inference server for you — no manual `docker run` or CLI flags to remember.

The UI is a React app with four areas: **Chat** (multi-turn against a running server), **Server** (load models, create/stop instances, tail logs), **Config** (paths and runtime defaults), and **Monitor** (GPU/VRAM and load progress). Chat supports markdown, math (KaTeX), and reasoning traces when the model emits them.

Under the hood, Revolver is a **control plane**, not the inference engine. A Node backend scans your disk for GGUF files (including Hugging Face hub layouts), reads metadata, estimates VRAM, and persists server definitions. When you load a model or create a server, the backend writes config into a shared volume and uses the **host Docker daemon** to spawn one container per server — `revolver-server-<id>` running the official `ghcr.io/ggml-org/llama.cpp` image for your backend (CPU, CUDA, ROCm, or Vulkan). Revolver tracks container lifecycle, parses logs for load phases, and proxies chat requests to the running `llama-server`.

You can run it two ways:

- **Electron** — desktop app; the main process hosts the same backend handlers and talks to Docker on your machine.
- **Docker Compose** — nginx serves the web UI on port 8080 and proxies `/api/*` to a loopback-bound backend that orchestrates llama containers via the mounted Docker socket.

In both modes, models stay on disk (bind-mounted into containers); Revolver only manages configuration and orchestration.

---

## Architecture

### Electron (desktop)

```
  ┌─────────────────┐
  │  Electron UI    │  React + Vite
  │  (renderer)     │
  └────────┬────────┘
           │ IPC (preload)
  ┌────────▼────────┐
  │  main process   │  server/handlers
  └────────┬────────┘
           │ docker CLI
  ┌────────▼────────────────────────────────────────┐
  │  host Docker daemon                             │
  │  ┌──────────────────┐  ┌──────────────────┐     │
  │  │ revolver-server- │  │ revolver-server- │     │
  │  │ <id>  (CUDA/CPU) │  │ <id>  …          │     │
  │  │  llama.cpp       │  │  llama.cpp       │     │
  │  └────────┬─────────┘  └────────┬─────────┘     │
  └───────────┼─────────────────────┼───────────────┘
              │                     │
         ~/.revolver/models    GGUF files on disk
```

### Docker (web)

```
  Browser ──► :8080 ──► ┌─────────────┐
                        │   nginx     │  static SPA
                        │  (frontend) │
                        └──────┬──────┘
                               │ /api/*
                        ┌──────▼──────┐
                        │   backend   │  Express :3001 (loopback)
                        │  (Node)     │
                        └──────┬──────┘
                               │ docker.sock
                        ┌──────▼──────────────────────────┐
                        │  host Docker daemon             │
                        │  ghcr.io/ggml-org/llama.cpp:*   │
                        │  one container per server def   │
                        └─────────────────────────────────┘
                               ▲
                               │ bind mount
                          $MODELS_DIR/*.gguf
```

**llama.cpp images** (picked by backend):

```
  cpu     ──►  ghcr.io/ggml-org/llama.cpp:server
  cuda    ──►  ghcr.io/ggml-org/llama.cpp:server-cuda
  rocm    ──►  ghcr.io/ggml-org/llama.cpp:server-rocm
  vulkan  ──►  ghcr.io/ggml-org/llama.cpp:server-vulkan
```

---

## Prerequisites

```
  Node.js 22+          npm
  Docker               (Electron + Docker deploy paths)
  NVIDIA Container Toolkit   (optional — GPU overlay)
  GGUF models          on disk under a known directory
```

---

## Environment (`.env`)

Docker Compose reads a `.env` file in the repo root for **host-side** paths and ports. Electron ignores this file — it uses `config.json` instead (see [Deploy → Electron](#electron)).

```bash
cp .env.example .env
```

Edit `.env` before `docker compose up`. Compose substitutes these values into `docker-compose.yml` and passes derived paths into the backend container.

| Variable | Default | Description |
|----------|---------|-------------|
| `MODELS_DIR` | `./models` | **Absolute host path** to your GGUF directory. Bind-mounted into the backend at `/models` and forwarded to the host Docker daemon as `REVOLVER_HOST_MODELS_DIR` when spawning llama.cpp containers. Relative paths (e.g. `./models`) work for the compose mount but **break container spawns** — always use an absolute path in production. |
| `FRONTEND_PORT` | `8080` | Host port for the nginx frontend (`http://localhost:<port>`). |
| `BACKEND_PORT` | `3001` | Host port for the Express API, bound to **127.0.0.1** only. The browser reaches it via the frontend's `/api/` proxy, not directly. |
| `NVIDIA_SMI_HOST_PATH` | `/usr/bin/nvidia-smi` | Host path to `nvidia-smi`, bind-mounted read-only into the backend when using the GPU overlay (`docker-compose.gpu.yml`) for VRAM monitoring. |
| `REVOLVER_LOCAL_ROOT` | *(unset)* | Optional override for local metadata root (chat DB, runtime config). Normally derived as `<MODELS_DIR>/.revolver` inside compose. |

**Example**

```bash
MODELS_DIR=/home/you/models
FRONTEND_PORT=8080
BACKEND_PORT=3001
NVIDIA_SMI_HOST_PATH=/usr/bin/nvidia-smi
```

Compose also sets internal backend variables (`REVOLVER_DOCKER`, `REVOLVER_MODELS_DIR`, `LLAMA_CONFIG_DIR`, etc.) — you do not need to add those to `.env`. The GPU overlay adds `LLAMA_GPU=1` and `NVIDIA_VISIBLE_DEVICES=all` automatically when you use `docker-compose.gpu.yml`.

For local development without Compose, the backend honors `PORT` (default `3001`) and the `REVOLVER_*` / `LLAMA_*` variables that Electron sets at startup.

---

## Development

```bash
npm install
npm run dev          # Vite + Electron hot reload
```

Backend only (no Electron shell):

```bash
npm run server       # http://127.0.0.1:3001
```

---

## Deploy

### Electron

Desktop app. Orchestrates **llama-server** via Docker on the host (same model as compose backend).

**Requirements**

- Docker installed and running
- User in `docker` group (or root)
- GGUF models reachable from paths in `config.json`

**1. Configure paths**

Edit `config.json` at the repo root (or your install dir):

```json
{
  "modelsDir": "/home/you/.revolver/models",
  "hubModelsDir": "/home/you/.revolver/hub/models",
  "localRoot": "/home/you/.revolver"
}
```

**2. Run**

```bash
npm install
npm run dev          # development
npm start            # production build + Electron
```

**3. Package (Linux)**

```bash
npm run pack         # AppImage + deb → release/
```

```
  npm run build  ──►  dist/ + dist-electron/
         │
         ▼
  electron-builder  ──►  release/
                          ├── Revolver-*.AppImage
                          └── revolver_*_amd64.deb
```

On first launch, Electron sets `REVOLVER_DOCKER=1`, detects GPU, and stores llama config under `data/llama-config/`. Each server definition spawns `revolver-server-<id>` on the host daemon.

---

### Docker

Browser UI + API backend. Frontend on **8080**; backend on **127.0.0.1:3001** (not exposed remotely by default).

**1. Environment**

Copy and edit `.env` — see [Environment (`.env`)](#environment-env). At minimum, set `MODELS_DIR` to an absolute host path.

**2. CPU**

```bash
npm run docker:up
# or: docker compose up --build
```

**3. GPU (NVIDIA)**

```bash
npm run docker:up:gpu
# or: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

**3b. Metal (macOS Apple Silicon)**

Native `llama-server` on the Mac host (Metal GPU). One command starts host agent + compose:

```bash
brew install llama.cpp
npm run docker:up:mac
```

Host agent starts in background automatically (`data/revolver-host-agent.log`). Debug foreground: `npm run host-agent`. Stop agent: `npm run host-agent:stop`.

In the Revolver UI, create a server with backend **Metal (macOS)**.

See [mac/README.md](mac/README.md) for details.

```
  docker compose up
        │
        ├── frontend   nginx :8080  ──► browser
        ├── backend    Node  :3001   ──► /api/* (via nginx proxy)
        └── volumes    models · revolver-data · llama-config
                              │
                              └── docker.sock ──► spawn llama.cpp on host
```

**4. Open**

```
  http://localhost:8080
```

**Layout**

| Service | Port | Notes |
|---------|------|-------|
| `frontend` | `${FRONTEND_PORT:-8080}` | SPA + `/api/` reverse proxy |
| `backend` | `127.0.0.1:${BACKEND_PORT:-3001}` | Control plane; needs Docker socket |

**Volumes**

```
  ./models (or MODELS_DIR)  ──►  /models          GGUF files
  revolver-data             ──►  /app/data         runtime state
  llama-config              ──►  /llama-config     entrypoint + env for llama containers
```

**Stop**

```bash
docker compose down
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Electron + Vite dev server |
| `npm run build` | Production renderer + main |
| `npm run build:web` | Web-only bundle (Docker frontend) |
| `npm run start` | Run packaged Electron app |
| `npm run pack` | Linux AppImage + deb |
| `npm run server` | Standalone Express backend |
| `npm run docker:up` | Compose stack (CPU) |
| `npm run docker:up:gpu` | Compose stack + NVIDIA GPU |
| `npm run docker:up:mac` | Compose stack + auto-start macOS Metal host agent |
| `npm run host-agent` | Host agent foreground (debug) |
| `npm run host-agent:stop` | Stop background host agent |

---

## License

Private — see repository owner for terms.
