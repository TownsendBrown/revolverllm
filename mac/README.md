# Revolver Mac — Metal llama-server stack

Containerized **manager** app + native **llama-server** on macOS with **Metal** GPU.

The manager runs in Docker. Inference runs on the host (Metal requires macOS). A small **host agent** bridges the two.

```
┌─────────────────────┐     unix socket      ┌──────────────────────────┐
│  manager (Docker)   │ ───────────────────► │  host-agent (macOS)      │
│  HTTP :3099         │                      │  spawn llama-server      │
│  writes env files   │                      │  Metal GPU               │
└──────────┬──────────┘                      └────────────┬─────────────┘
           │ shared ./data/llama-config                     │
           └────────────────────────────────────────────────┘
                                    │
                                    ▼
                          host.docker.internal:8082
                          OpenAI-compatible API
```

## Layout

| Path | Role |
|------|------|
| `manager/` | Docker app — HTTP API, server definitions, env files |
| `host-agent/` | macOS daemon — start/stop/logs for local `llama-server` |
| `llama-server/entrypoint.sh` | Env → CLI args (Metal, path mapping) |
| `scripts/` | Install llama-server, host agent lifecycle, `docker-up-mac.sh` |
| `docker-compose.yml` | Starts manager container |
| `data/` | Shared config + socket (created at runtime) |

## Prerequisites

- macOS on Apple Silicon (Metal)
- Docker Desktop
- Node.js 22+ (for host agent)
- Homebrew (to install llama-server)

## Main Revolver app (recommended)

From repo root — host agent starts automatically:

```bash
brew install llama.cpp
# Set MODELS_DIR in .env (absolute path)
npm run docker:up:mac
```

Open `http://localhost:8080` → Servers → backend **Metal (macOS)**.

| Command | Description |
|---------|-------------|
| `npm run docker:up:mac` | Start host agent (background) + compose stack |
| `npm run host-agent` | Host agent foreground (debug) |
| `npm run host-agent:stop` | Stop background host agent |

Logs: `data/revolver-host-agent.log` · Socket: `data/revolver-llama.sock`

---

## Standalone manager (optional)

The manager container (`mac/docker-compose.yml`, port `:3099`) is for curl-only testing without the main UI.

### 1. Install Metal llama-server on the host

```bash
chmod +x mac/scripts/*.sh mac/llama-server/entrypoint.sh
./mac/scripts/install-llama-server.sh
```

Or manually: `brew install llama.cpp`

### 2. Configure environment (standalone manager only)

```bash
cp mac/.env.example mac/.env
# Edit MODELS_DIR — must be an absolute path to your GGUF directory
```

### 3. Start the host agent (standalone manager)

```bash
npm run host-agent
```

Or from repo root: `./mac/scripts/run-host-agent.sh`

### 4. Start the manager container

```bash
cd mac
docker compose up --build
```

Manager API: `http://localhost:3099`

## Usage

### Create and start a server

```bash
# Create (modelPath relative to MODELS_DIR or absolute under /models in container)
curl -s -X POST http://localhost:3099/servers \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-model",
    "modelPath": "/models/your-model.gguf",
    "contextLength": 8192
  }'

# Start (loads model via host agent → Metal llama-server)
curl -s -X POST http://localhost:3099/servers/<id>/start

# Chat (directly against host llama-server)
curl -s http://localhost:8082/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "any",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": false
  }'
```

### Other endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Manager health |
| GET | `/host-agent/ping` | Host agent reachable |
| GET | `/servers` | List servers + runtime status |
| POST | `/servers/:id/stop` | Stop llama-server |
| DELETE | `/servers/:id` | Remove server |
| GET | `/servers/:id/logs` | Tail host agent logs |

### Host agent CLI

```bash
cd mac/host-agent
npm run cli -- ping
npm run cli -- list
npm run cli -- restart <serverId> 8082
```

## Env files (Revolver-compatible)

Load config is written to `data/llama-config/llama-load-<id>.env` — same format as main Revolver stack. A future Revolver `metal` backend can share this directory.

## Metal notes

- `BACKEND=metal` sets `--n-gpu-layers -1` (all layers on GPU) unless overridden
- `MODELS_HOST_DIR` maps `/models/...` paths from env files to the host `MODELS_DIR`
- llama-server must be a **macOS** build (Homebrew `llama.cpp`); Linux binaries in Docker cannot use Metal

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `host agent socket` errors | Run `npm run docker:up:mac` (auto-starts agent) or `npm run host-agent` |
| `llama-server binary not found` | Run `install-llama-server.sh` or set `LLAMA_SERVER_BIN` |
| Model not found | Use `/models/...` paths; set absolute `MODELS_DIR` in `.env` |
| Port in use | Each server gets next port from 8082; stop old servers |

## Integration with main Revolver

Metal is wired into the main backend:

- Create servers in the UI with backend **Metal (macOS)** — same lifecycle, logs, chat, and monitor panels as Docker backends.
- Load config uses shared `data/llama-config/llama-load-<id>.env` (Revolver-compatible format).
- `npm run docker:up:mac` from repo root starts host agent + main Revolver stack automatically.

The standalone manager under `mac/manager/` remains available for curl-only testing on `:3099` but is not required when using the main app.
