import { connect, type Socket } from "net";

export interface HostAgentEndpoint {
  host: string;
  port: number;
  socketPath?: string;
}

export function resolveHostAgentEndpoint(): HostAgentEndpoint {
  const port = Number(process.env.REVOLVER_LLAMA_PORT ?? 9742);
  const host = process.env.REVOLVER_LLAMA_HOST ?? "127.0.0.1";
  const socketPath = process.env.REVOLVER_LLAMA_SOCKET;
  if (process.env.REVOLVER_LLAMA_HOST) {
    return { host, port };
  }
  if (socketPath) {
    return { host, port, socketPath };
  }
  return { host, port };
}

export function connectHostAgent(endpoint = resolveHostAgentEndpoint()): Socket {
  if (endpoint.socketPath) return connect(endpoint.socketPath);
  return connect({ host: endpoint.host, port: endpoint.port });
}

/** Line-delimited JSON RPC. Waits for one response line before closing. */
export function hostAgentCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 120_000,
  endpoint?: HostAgentEndpoint,
): Promise<T> {
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
      socket = connectHostAgent(endpoint);
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
