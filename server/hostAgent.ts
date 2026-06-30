import { connect, type Socket } from "net";
import type { ServerDefinition } from "../shared/types";

export function isMetalBackend(def: Pick<ServerDefinition, "backend">): boolean {
  return def.backend === "metal";
}

function hostAgentEndpoint(): { host: string; port: number; socketPath?: string } {
  const port = Number(process.env.REVOLVER_LLAMA_PORT ?? 9742);
  if (process.env.REVOLVER_LLAMA_HOST) {
    return { host: process.env.REVOLVER_LLAMA_HOST, port };
  }
  const socketPath = process.env.REVOLVER_LLAMA_SOCKET ?? null;
  if (socketPath) return { host: "127.0.0.1", port, socketPath };
  return { host: "127.0.0.1", port };
}

export function hostAgentSocket(): string | null {
  return process.env.REVOLVER_LLAMA_SOCKET ?? null;
}

export function metalEnabled(): boolean {
  return Boolean(process.env.REVOLVER_LLAMA_HOST || hostAgentSocket());
}

function connectHostAgent(): Socket {
  const ep = hostAgentEndpoint();
  if (ep.socketPath) return connect(ep.socketPath);
  return connect({ host: ep.host, port: ep.port });
}

export async function hostAgentCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<T> {
  if (!metalEnabled()) {
    throw new Error("Metal host agent not configured (set REVOLVER_LLAMA_HOST or REVOLVER_LLAMA_SOCKET)");
  }

  return new Promise((resolve, reject) => {
    const id = String(Date.now());
    let socket: Socket;
    let out = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        /* gone */
      }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error("host agent timeout")));
    }, timeoutMs);

    try {
      socket = connectHostAgent();
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(() => reject(new Error("host agent timeout"))));
    socket.on("error", (e) => finish(() => reject(new Error(`host agent socket: ${e.message}`))));

    socket.on("data", (chunk) => {
      out += chunk.toString();
      const idx = out.indexOf("\n");
      if (idx < 0) return;
      const line = out.slice(0, idx).trim();
      if (!line) return;
      finish(() => {
        try {
          const res = JSON.parse(line) as { result?: T; error?: string };
          if (res.error) reject(new Error(res.error));
          else resolve(res.result as T);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });

    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

export async function hostAgentPing(): Promise<boolean> {
  if (!metalEnabled()) return false;
  try {
    await hostAgentCall("ping", undefined, 5_000);
    return true;
  } catch {
    return false;
  }
}
