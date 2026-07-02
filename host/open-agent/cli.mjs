import { connect } from "node:net";

const method = process.argv[2] ?? "ping";
const host = process.env.REVOLVER_HOST_AGENT_HOST ?? "127.0.0.1";
const port = Number(process.env.REVOLVER_HOST_AGENT_PORT ?? 9743);
const socketPath = process.env.REVOLVER_HOST_AGENT_SOCKET;

/** @param {string} rpcMethod @param {Record<string, unknown> | undefined} params */
function call(rpcMethod, params) {
  return new Promise((resolve, reject) => {
    const id = String(Date.now());
    const socket = socketPath ? connect(socketPath) : connect({ host, port });
    let out = "";
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        /* gone */
      }
      fn();
    };

    const timer = setTimeout(() => finish(() => reject(new Error("host open agent timeout"))), 5000);

    socket.on("error", (e) => finish(() => reject(e)));
    socket.on("data", (chunk) => {
      out += chunk.toString();
      const idx = out.indexOf("\n");
      if (idx < 0) return;
      finish(() => {
        clearTimeout(timer);
        try {
          const res = JSON.parse(out.slice(0, idx).trim());
          if (res.error) reject(new Error(res.error));
          else resolve(res.result);
        } catch (e) {
          reject(e);
        }
      });
    });

    socket.write(`${JSON.stringify({ id, method: rpcMethod, params })}\n`);
  });
}

call(method)
  .then((result) => {
    if (result !== undefined && result !== "") {
      console.log(typeof result === "object" ? JSON.stringify(result) : result);
    }
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
