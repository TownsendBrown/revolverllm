import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createServer } from "node:net";
import { openPathOnHost } from "./openPath.mjs";

const SOCKET_PATH = process.env.REVOLVER_HOST_AGENT_SOCKET;
const TCP_HOST = process.env.REVOLVER_HOST_AGENT_BIND ?? "0.0.0.0";
const TCP_PORT = Number(process.env.REVOLVER_HOST_AGENT_PORT ?? 9743);

/** @param {{ id: string; method: string; params?: { path?: string } }} req */
function handle(req) {
  const { id, method } = req;
  try {
    switch (method) {
      case "ping":
        return Promise.resolve({ id, result: { ok: true } });
      case "openPath":
        return openPathOnHost(req.params.path).then((result) => ({ id, result }));
      default:
        return Promise.resolve({ id, error: `unknown method: ${method}` });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Promise.resolve({ id, error: message });
  }
}

/** @param {import("node:net").Socket} socket */
function attachClient(socket) {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        socket.write(`${JSON.stringify({ id: "?", error: "invalid json" })}\n`);
        continue;
      }
      void handle(req).then((res) => {
        if (socket.destroyed) return;
        socket.write(`${JSON.stringify(res)}\n`, (err) => {
          if (err && /** @type {NodeJS.ErrnoException} */ (err).code !== "EPIPE") {
            console.error("[host-open-agent] socket write error:", err.message);
          }
          if (!socket.destroyed) socket.end();
        });
      });
    }
  });
  socket.on("error", (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EPIPE") {
      console.error("[host-open-agent] client socket error:", err.message);
    }
  });
}

function startUnixSocket() {
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
    console.log(`[host-open-agent] unix://${SOCKET_PATH}`);
  });
  server.on("error", (err) => {
    console.error("[host-open-agent] unix socket error:", err.message);
    process.exit(1);
  });
}

function startTcpServer() {
  const server = createServer(attachClient);
  server.listen(TCP_PORT, TCP_HOST, () => {
    console.log(`[host-open-agent] tcp://${TCP_HOST}:${TCP_PORT}`);
  });
  server.on("error", (err) => {
    console.error("[host-open-agent] tcp socket error:", err.message);
    process.exit(1);
  });
}

startTcpServer();
startUnixSocket();
