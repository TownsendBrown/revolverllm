import { connect, type Socket } from "net";

function hostOpenAgentEndpoint(): { host: string; port: number; socketPath?: string } | null {
  const port = Number(process.env.REVOLVER_HOST_AGENT_PORT ?? 9743);
  if (process.env.REVOLVER_HOST_AGENT_HOST) {
    return { host: process.env.REVOLVER_HOST_AGENT_HOST, port };
  }
  const socketPath = process.env.REVOLVER_HOST_AGENT_SOCKET ?? null;
  if (socketPath) return { host: "127.0.0.1", port, socketPath };
  return null;
}

export function hostOpenAgentEnabled(): boolean {
  return hostOpenAgentEndpoint() !== null;
}

function connectHostOpenAgent(): Socket {
  const ep = hostOpenAgentEndpoint();
  if (!ep) throw new Error("Host open agent not configured");
  if (ep.socketPath) return connect(ep.socketPath);
  return connect({ host: ep.host, port: ep.port });
}

export async function hostOpenAgentCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!hostOpenAgentEnabled()) {
    throw new Error(
      "Host open agent not configured (set REVOLVER_HOST_AGENT_HOST or REVOLVER_HOST_AGENT_SOCKET)",
    );
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
      finish(() => reject(new Error("host open agent timeout")));
    }, timeoutMs);

    try {
      socket = connectHostOpenAgent();
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish(() => reject(new Error("host open agent timeout"))));
    socket.on("error", (e) => finish(() => reject(new Error(`host open agent socket: ${e.message}`))));

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

export async function hostOpenAgentPing(): Promise<boolean> {
  if (!hostOpenAgentEnabled()) return false;
  try {
    await hostOpenAgentCall("ping", undefined, 5_000);
    return true;
  } catch {
    return false;
  }
}
