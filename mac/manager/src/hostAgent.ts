import { connect, type Socket } from "net";

const SOCKET_PATH = process.env.REVOLVER_LLAMA_SOCKET ?? "/var/run/revolver-llama.sock";

export async function hostAgentCall<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
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
    }, 120_000);

    socket = connect(SOCKET_PATH);
    socket.setTimeout(120_000);
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

export async function waitForLlamaReady(
  host: string,
  port: number,
  deadlineMs = 300_000,
): Promise<void> {
  const base = `http://${host}:${port}`;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (health.ok) return;
    } catch {
      /* try models */
    }
    try {
      const models = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (models.ok) {
        const body = (await models.json()) as { data?: unknown[] };
        if ((body.data?.length ?? 0) > 0) return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for llama-server on ${base}`);
}
