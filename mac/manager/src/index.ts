import express from "express";
import {
  clearLoadEnv,
  createServer,
  deleteServer,
  getServer,
  listServers,
  writeLoadEnv,
} from "./store.js";
import { hostAgentCall, waitForLlamaReady } from "./hostAgent.js";

const PORT = Number(process.env.PORT ?? 3099);
const LLAMA_CONNECT_HOST = process.env.LLAMA_CONNECT_HOST ?? "host.docker.internal";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, runtime: "mac-metal-manager" });
});

app.get("/servers", async (_req, res) => {
  const servers = listServers();
  const live = await hostAgentCall<Array<{ serverId: string; status: string; pid: number | null }>>(
    "list",
  ).catch(() => []);
  const byId = new Map(live.map((s) => [s.serverId, s]));
  res.json({
    servers: servers.map((s) => ({
      ...s,
      baseUrl: `http://${LLAMA_CONNECT_HOST}:${s.hostPort}`,
      runtime: byId.get(s.id) ?? null,
    })),
  });
});

app.post("/servers", (req, res) => {
  const { name, modelPath, contextLength, nGpuLayers, mmprojPath, kvCacheDtype } = req.body ?? {};
  if (!modelPath || typeof modelPath !== "string") {
    res.status(400).json({ error: "modelPath required" });
    return;
  }
  const def = createServer({
    name,
    modelPath,
    contextLength,
    nGpuLayers,
    mmprojPath,
    kvCacheDtype,
  });
  res.status(201).json(def);
});

app.post("/servers/:id/start", async (req, res) => {
  const def = getServer(req.params.id);
  if (!def) {
    res.status(404).json({ error: "server not found" });
    return;
  }
  try {
    writeLoadEnv(def);
    const inspect = await hostAgentCall("restart", {
      serverId: def.id,
      hostPort: def.hostPort,
    });
    await waitForLlamaReady(LLAMA_CONNECT_HOST, def.hostPort);
    res.json({
      ...def,
      baseUrl: `http://${LLAMA_CONNECT_HOST}:${def.hostPort}`,
      inspect,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/servers/:id/stop", async (req, res) => {
  const def = getServer(req.params.id);
  if (!def) {
    res.status(404).json({ error: "server not found" });
    return;
  }
  clearLoadEnv(def.id);
  const inspect = await hostAgentCall("stop", { serverId: def.id });
  res.json({ ok: true, inspect });
});

app.delete("/servers/:id", async (req, res) => {
  const def = getServer(req.params.id);
  if (!def) {
    res.status(404).json({ error: "server not found" });
    return;
  }
  clearLoadEnv(def.id);
  await hostAgentCall("stop", { serverId: def.id }).catch(() => {});
  deleteServer(def.id);
  res.json({ ok: true });
});

app.get("/servers/:id/logs", async (req, res) => {
  const tail = Number(req.query.tail ?? 200);
  const lines = await hostAgentCall<string[]>("logs", {
    serverId: req.params.id,
    tail,
  });
  res.json({ lines });
});

app.get("/host-agent/ping", async (_req, res) => {
  try {
    const result = await hostAgentCall("ping");
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(503).json({ error: message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[mac-manager] http://0.0.0.0:${PORT}`);
  console.log(`[mac-manager] llama connect host=${LLAMA_CONNECT_HOST}`);
});
