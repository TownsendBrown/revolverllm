import type { Request, Response, NextFunction } from "express";
import { loadServerConfig, saveServerConfig } from "../electron/lib/serverConfig";

/** Control-plane API key — shared with OpenAI gateway when REVOLVER_API_KEY is set. */
export function getApiKey(): string | null {
  const env = process.env.REVOLVER_API_KEY?.trim();
  if (env) return env;
  return loadServerConfig().gatewayApiKey;
}

export function hasApiKeyConfigured(): boolean {
  return Boolean(getApiKey());
}

export function checkApiAuth(req: Request, res: Response): boolean {
  const key = getApiKey();
  if (!key) return true;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${key}`) return true;
  res.status(401).json({ error: "Unauthorized" });
  return false;
}

/** Require Bearer token on /api/* when a key is configured. */
export function apiAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!checkApiAuth(req, res)) return;
  next();
}

/** Apply REVOLVER_API_KEY to gateway config on boot. */
export function seedApiKeyFromEnv(): void {
  const env = process.env.REVOLVER_API_KEY?.trim();
  if (!env) return;
  const cfg = loadServerConfig();
  if (cfg.gatewayApiKey !== env) {
    saveServerConfig({ gatewayApiKey: env });
  }
}
