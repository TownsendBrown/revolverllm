import { createServer, type Socket } from "net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { HostAgentRequest, HostAgentResponse } from "./protocol.js";
import { getHostMonitorSnapshot } from "./monitor.js";
import { openHostPath } from "./openPath.js";
import { Supervisor } from "./supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOCKET_PATH = process.env.REVOLVER_LLAMA_SOCKET;
const TCP_HOST = process.env.REVOLVER_LLAMA_BIND ?? "0.0.0.0";
const TCP_PORT = Number(process.env.REVOLVER_LLAMA_PORT ?? 9742);
const CONFIG_DIR = process.env.LLAMA_CONFIG_DIR ?? "./data/llama-config";
const MODELS_HOST_DIR = process.env.MODELS_HOST_DIR ?? process.env.MODELS_DIR ?? "./models";
const LLAMA_SERVER_BIN = process.env.LLAMA_SERVER_BIN;

const supervisor = new Supervisor({
  configDir: CONFIG_DIR,
  modelsHostDir: MODELS_HOST_DIR,
  llamaServerBin: LLAMA_SERVER_BIN,
});

function handle(req: HostAgentRequest): Promise<HostAgentResponse> {
  const { id, method } = req;
  try {
    switch (method) {
      case "ping":
        return Promise.resolve({ id, result: { ok: true, metal: true } });
      case "ensure": {
        const p = req.params;
        return Promise.resolve({ id, result: supervisor.ensure(p.serverId, p.hostPort) });
      }
      case "restart": {
        const p = req.params;
        return supervisor.restart(p.serverId, p.hostPort).then((result) => ({ id, result }));
      }
      case "stop":
        return supervisor.stop(req.params.serverId).then((result) => ({ id, result }));
      case "inspect":
        return Promise.resolve({ id, result: supervisor.inspect(req.params.serverId) });
      case "logs": {
        const p = req.params;
        return Promise.resolve({
          id,
          result: supervisor.logs(p.serverId, p.tail ?? 200),
        });
      }
      case "list":
        return Promise.resolve({ id, result: supervisor.list() });
      case "monitor":
        return Promise.resolve({ id, result: getHostMonitorSnapshot() });
      case "openPath":
        return openHostPath(req.params.path).then((result) => ({ id, result }));
      default:
        return Promise.resolve({ id, error: `unknown method: ${(req as HostAgentRequest).method}` });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Promise.resolve({ id, error: message });
  }
}

function attachClient(socket: Socket): void {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req: HostAgentRequest;
      try {
        req = JSON.parse(line) as HostAgentRequest;
      } catch {
        socket.write(`${JSON.stringify({ id: "?", error: "invalid json" })}\n`);
        continue;
      }
      void handle(req).then((res) => {
        if (socket.destroyed) return;
        socket.write(`${JSON.stringify(res)}\n`, (err) => {
          if (err && (err as NodeJS.ErrnoException).code !== "EPIPE") {
            console.error("[host-agent] socket write error:", err.message);
          }
          if (!socket.destroyed) socket.end();
        });
      });
    }
  });
  socket.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code !== "EPIPE") {
      console.error("[host-agent] client socket error:", err.message);
    }
  });
}

function startUnixSocket(): void {
  if (!SOCKET_PATH) return;
  mkdirSync(dirname(SOCKET_PATH), { recursive: true });
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      /* in use */
    }
  }
  const server = createServer(attachClient);
  server.listen(SOCKET_PATH, () => {
    chmodSync(SOCKET_PATH, 0o666);
    console.log(`[host-agent] unix://${SOCKET_PATH}`);
  });
  server.on("error", (err) => {
    console.error("[host-agent] unix socket error:", err.message);
    process.exit(1);
  });
}

function startTcpServer(): void {
  const server = createServer(attachClient);
  server.listen(TCP_PORT, TCP_HOST, () => {
    console.log(`[host-agent] tcp://${TCP_HOST}:${TCP_PORT}`);
  });
  server.on("error", (err) => {
    console.error("[host-agent] tcp socket error:", err.message);
    process.exit(1);
  });
}

startTcpServer();
startUnixSocket();
console.log(`[host-agent] config=${CONFIG_DIR} models=${MODELS_HOST_DIR}`);
