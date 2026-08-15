#!/usr/bin/env node
/**
 * Stand-in for llama-server used by `npm run test:native`.
 * Honors --host/--port (and LLAMA_* env) and serves /health, /v1/models, /props.
 */
import http from "node:http";

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const host = arg("--host", process.env.LLAMA_HOST || "127.0.0.1");
const port = Number(arg("--port", process.env.LLAMA_PORT || "8082"));
const model = arg("--model", process.env.MODEL_PATH || "");
const visible = process.env.CUDA_VISIBLE_DEVICES ?? "";

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  if (url.startsWith("/health")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "local" }] }));
    return;
  }
  if (url.startsWith("/props")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const listenHost = host === "0.0.0.0" ? "127.0.0.1" : host;
server.listen(port, listenHost, () => {
  console.log(
    `HTTP server listening on ${listenHost}:${port} model=${model} CUDA_VISIBLE_DEVICES=${visible}`,
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
