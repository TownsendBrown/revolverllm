import type { Express, Request, Response } from "express";
import express from "express";
import cors from "cors";
import { Readable } from "node:stream";
import { loadServerConfig } from "../electron/lib/serverConfig";
import {
  GatewayRoutingError,
  openAiModelsResponse,
} from "./gatewayRouting";
import { serverManager } from "./serverManager";

function gatewayBindHost(): string {
  const cfg = loadServerConfig();
  return process.env.REVOLVER_GATEWAY_HOST ?? cfg.host;
}

function gatewayPort(): number {
  const cfg = loadServerConfig();
  return Number(process.env.REVOLVER_GATEWAY_PORT ?? cfg.port);
}

function checkGatewayAuth(req: Request, res: Response): boolean {
  const cfg = loadServerConfig();
  if (!cfg.gatewayApiKey) return true;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${cfg.gatewayApiKey}`) return true;
  res.status(401).json({
    error: { message: "Invalid API key", type: "invalid_request_error" },
  });
  return false;
}

function gatewayDisabled(_req: Request, res: Response): boolean {
  const cfg = loadServerConfig();
  if (cfg.gatewayEnabled !== false) return false;
  res.status(503).json({
    error: { message: "OpenAI gateway is disabled", type: "gateway_error" },
  });
  return true;
}

async function proxyPost(req: Request, res: Response, path: string): Promise<void> {
  const clientAbort = new AbortController();
  const onClose = () => clientAbort.abort();
  req.on("close", onClose);
  req.on("aborted", onClose);

  try {
    const body = req.body as Record<string, unknown> | undefined;
    const model = typeof body?.model === "string" ? body.model : undefined;
    const { route } = await serverManager.resolveGateway(model);
    route.markActivity();

    const upstreamBody = { ...body, model: route.upstreamModel };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (route.apiKey) headers.Authorization = `Bearer ${route.apiKey}`;

    const upstream = await fetch(`http://${route.host}:${route.port}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamBody),
      signal: clientAbort.signal,
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    const stream = body?.stream === true;
    if (stream && upstream.body) {
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
      nodeStream.on("error", () => {
        if (!res.writableEnded) res.end();
      });
      nodeStream.pipe(res);
      res.on("close", () => {
        nodeStream.destroy();
        clientAbort.abort();
      });
      return;
    }

    res.send(await upstream.text());
  } catch (e) {
    if (clientAbort.signal.aborted) return;
    if (e instanceof GatewayRoutingError) {
      res.status(e.status).json({
        error: { message: e.message, type: "gateway_error" },
      });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    res.status(502).json({
      error: { message, type: "gateway_error" },
    });
  } finally {
    req.off("close", onClose);
    req.off("aborted", onClose);
  }
}

export function createOpenAiGatewayApp(): Express {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.use((req, res, next) => {
    if (gatewayDisabled(req, res)) return;
    if (!checkGatewayAuth(req, res)) return;
    const cfg = loadServerConfig();
    if (cfg.cors) {
      cors({ origin: true })(req, res, next);
    } else {
      next();
    }
  });

  app.get("/health", async (_req, res) => {
    try {
      const entries = await serverManager.listGatewayModels();
      res.json({
        status: "ok",
        gateway: true,
        servers: entries.length,
        models: entries.map((e) => e.id),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({ status: "error", message });
    }
  });

  app.get("/v1/models", async (_req, res) => {
    try {
      const entries = await serverManager.listGatewayModels();
      res.json(openAiModelsResponse(entries));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      res.status(500).json({
        error: { message, type: "gateway_error" },
      });
    }
  });

  app.post("/v1/chat/completions", (req, res) => {
    void proxyPost(req, res, "/v1/chat/completions");
  });

  app.post("/v1/completions", (req, res) => {
    void proxyPost(req, res, "/v1/completions");
  });

  app.post("/v1/embeddings", (req, res) => {
    void proxyPost(req, res, "/v1/embeddings");
  });

  return app;
}

let gatewayServer: ReturnType<Express["listen"]> | null = null;

export function isGatewayRunning(): boolean {
  return gatewayServer != null;
}

export async function startOpenAiGateway(): Promise<void> {
  const cfg = loadServerConfig();
  if (cfg.gatewayEnabled === false) return;
  if (gatewayServer) return;

  const app = createOpenAiGatewayApp();
  const host = gatewayBindHost();
  const port = gatewayPort();

  await new Promise<void>((resolve, reject) => {
    gatewayServer = app.listen(port, host, () => {
      console.log(`[revolver] OpenAI gateway listening on http://${host}:${port}`);
      resolve();
    });
    gatewayServer.on("error", reject);
  });
}

export async function stopOpenAiGateway(): Promise<void> {
  if (!gatewayServer) return;
  const server = gatewayServer;
  gatewayServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function restartOpenAiGateway(): Promise<void> {
  await stopOpenAiGateway();
  await startOpenAiGateway();
}

export { gatewayBindHost, gatewayPort };
