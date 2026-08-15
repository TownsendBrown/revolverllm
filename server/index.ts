import cors from "cors";
import express from "express";
import { handlers } from "./handlers";
import { serverManager } from "./serverManager";
import { startOpenAiGateway } from "./openaiGateway";

const app = express();
const port = Number(process.env.PORT ?? "3001");

app.use(cors());
app.use(express.json({ limit: "2mb" }));

type HandlerName = keyof typeof handlers;

const routes: Array<{ method: "get" | "post"; path: string; name: HandlerName }> = [
  { method: "get", path: "/api/paths", name: "getPaths" },
  { method: "get", path: "/api/config", name: "getConfig" },
  { method: "post", path: "/api/config", name: "setConfig" },
  { method: "get", path: "/api/gpu", name: "getGpu" },
  { method: "get", path: "/api/platform", name: "getPlatform" },
  { method: "get", path: "/api/monitor", name: "getMonitor" },
  { method: "get", path: "/api/models", name: "getModels" },
  { method: "get", path: "/api/engines", name: "getEngines" },
  { method: "post", path: "/api/vram/estimate", name: "estimateVram" },
  { method: "post", path: "/api/models/load", name: "loadModel" },
  { method: "post", path: "/api/models/load-path", name: "loadModelFromPath" },
  { method: "post", path: "/api/models/unload", name: "unloadModel" },
  { method: "get", path: "/api/servers", name: "listServers" },
  { method: "post", path: "/api/servers", name: "createServer" },
  { method: "get", path: "/api/server/config", name: "getServerConfig" },
  { method: "post", path: "/api/server/config", name: "setServerConfig" },
  { method: "get", path: "/api/runtime/config", name: "getRuntimeConfig" },
  { method: "post", path: "/api/runtime/config", name: "setRuntimeConfig" },
  { method: "post", path: "/api/open-path", name: "openPath" },
];

for (const route of routes) {
  app[route.method](route.path, async (req, res) => {
    try {
      const fn = handlers[route.name] as (...args: unknown[]) => unknown;
      const body = route.method === "get" ? undefined : (req.body ?? {});
      const result =
        route.name === "openPath"
          ? await fn(body.path ?? body)
          : route.method === "get"
            ? await fn()
            : await fn(body);
      res.json(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const status = message.startsWith("GUARDRAIL_BLOCKED") ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });
}

app.get("/api/server/status", async (req, res) => {
  try {
    const serverId = typeof req.query.id === "string" ? req.query.id : undefined;
    res.json(await handlers.getServerStatus(serverId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/server/logs/clear", async (req, res) => {
  try {
    const serverId = typeof req.body?.serverId === "string" ? req.body.serverId : undefined;
    res.json(await handlers.clearServerLogs(serverId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body ?? {};
    res.json(await handlers.chat(body.messages ?? body, body.serverId));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/api/servers/:id/start", async (req, res) => {
  try {
    res.json(await handlers.startServer(req.params.id, req.body?.force === true));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/api/servers/:id/stop", async (req, res) => {
  try {
    await handlers.stopServer(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.delete("/api/servers/:id", async (req, res) => {
  try {
    await handlers.deleteServer(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.get("/api/conversations", async (_req, res) => {
  try {
    res.json(await handlers.listConversations());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/conversations", async (req, res) => {
  try {
    res.json(await handlers.createConversation(req.body ?? {}));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/conversations/:id", async (req, res) => {
  try {
    res.json(await handlers.getConversation(req.params.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.patch("/api/conversations/:id", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (body.title != null) {
      res.json(await handlers.renameConversation(req.params.id, String(body.title)));
      return;
    }
    if (
      body.serverId !== undefined ||
      body.modelId !== undefined ||
      body.modelPath !== undefined ||
      body.modelDisplayName !== undefined ||
      body.backendId !== undefined
    ) {
      res.json(await handlers.updateConversationMeta(req.params.id, body));
      return;
    }
    res.status(400).json({ error: "Nothing to update" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.delete("/api/conversations/:id", async (req, res) => {
  try {
    await handlers.deleteConversation(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/api/conversations/:id/messages", async (req, res) => {
  try {
    const content = String(req.body?.content ?? "");
    if (!content.trim()) {
      res.status(400).json({ error: "content required" });
      return;
    }
    const serverId =
      typeof req.body?.serverId === "string" ? req.body.serverId : req.body?.serverId ?? null;
    const enableThinking = req.body?.enableThinking === true;
    res.json(await handlers.sendMessage(req.params.id, content, serverId, undefined, enableThinking));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/api/conversations/:id/messages/stream", async (req, res) => {
  const content = String(req.body?.content ?? "");
  if (!content.trim()) {
    res.status(400).json({ error: "content required" });
    return;
  }
  const serverId =
    typeof req.body?.serverId === "string" ? req.body.serverId : req.body?.serverId ?? null;
  const enableThinking = req.body?.enableThinking === true;

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  req.socket.setTimeout(0);
  res.flushHeaders?.();
  res.write(": connected\n\n");

  let clientClosed = false;
  const markClosed = () => {
    clientClosed = true;
  };
  res.on("close", markClosed);

  const heartbeat = setInterval(() => {
    if (clientClosed || res.writableEnded) return;
    try {
      res.write(": ping\n\n");
    } catch {
      clientClosed = true;
    }
  }, 15000);

  const writeEvent = (payload: unknown) => {
    if (clientClosed || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clientClosed = true;
    }
  };

  try {
    const result = await handlers.sendMessage(
      req.params.id,
      content,
      serverId,
      (delta) => {
        writeEvent({ delta });
      },
      enableThinking,
    );
    writeEvent({ done: true, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeEvent({ error: message });
  } finally {
    clearInterval(heartbeat);
    res.off("close", markClosed);
    if (!res.writableEnded) res.end();
  }
});

app.get("/api/benchmarks/definitions", async (_req, res) => {
  try {
    res.json(await handlers.listBenchmarkDefinitions());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/benchmarks/runs", async (_req, res) => {
  try {
    res.json(await handlers.listBenchmarkRuns());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/benchmarks/runs/:id", async (req, res) => {
  try {
    res.json(await handlers.getBenchmarkRun(req.params.id));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.post("/api/benchmarks/runs", async (req, res) => {
  try {
    res.json(await handlers.startBenchmarkRun(req.body ?? {}));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

app.post("/api/benchmarks/runs/:id/cancel", async (req, res) => {
  try {
    res.json(await handlers.cancelBenchmarkRun(req.params.id));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/api/benchmarks/runs/:id", async (req, res) => {
  try {
    await handlers.deleteBenchmarkRun(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/benchmarks/runs/:runId/tests/:testId/human-score", async (req, res) => {
  try {
    const body = req.body ?? {};
    res.json(
      await handlers.setBenchmarkHumanScore(
        req.params.runId,
        req.params.testId as import("../shared/benchmarks/types").BenchmarkCategory,
        Number(body.humanScore),
        body.humanMaxScore != null ? Number(body.humanMaxScore) : undefined,
        body.humanNotes != null ? String(body.humanNotes) : undefined,
      ),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

function artifactContentType(filename: string): string {
  if (filename.endsWith(".html")) return "text/html; charset=utf-8";
  if (filename.endsWith(".ts") || filename.endsWith(".tsx")) return "text/plain; charset=utf-8";
  if (filename.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (filename.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

app.get("/api/benchmarks/runs/:runId/artifacts/:testId/:filename", async (req, res) => {
  try {
    const relPath = `${req.params.testId}/${req.params.filename}`;
    const buf = await handlers.getBenchmarkArtifact(req.params.runId, relPath);
    res.setHeader("Content-Type", artifactContentType(req.params.filename));
    res.setHeader("Cache-Control", "no-cache");
    res.send(buf);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(message.includes("not found") ? 404 : 500).json({ error: message });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, docker: true });
});

async function start(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    console.error("[revolver] unhandledRejection:", reason);
  });

  // Adopt any model containers still running from a previous backend lifetime
  // before serving, so status reflects reality instead of empty in-memory state.
  try {
    await serverManager.reconcile();
  } catch (e) {
    console.warn(`reconcile on boot failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await startOpenAiGateway();
  } catch (e) {
    console.warn(`OpenAI gateway failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }
  app.listen(port, "0.0.0.0", () => {
    console.log(`revolver backend listening on :${port}`);
  });
}

void start();
