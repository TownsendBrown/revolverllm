import type { ServerDefinition } from "../shared/types";
import type { InstanceRuntime } from "./instanceRuntime";

export interface GatewayModelEntry {
  /** Model id exposed to OpenAI clients (e.g. Cline). */
  id: string;
  serverId: string;
  serverName: string;
  /** Model field sent to the upstream inference server. */
  upstreamModel: string;
  aliases: string[];
}

export interface GatewayRoute {
  host: string;
  port: number;
  upstreamModel: string;
  apiKey: string | null;
  serverId: string;
  markActivity: () => void;
}

export class GatewayRoutingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayRoutingError";
  }
}

function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase();
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/** Aliases that map a client model id to a running server. */
export function modelAliases(def: ServerDefinition, upstreamModel: string): string[] {
  const aliases = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value?.trim()) aliases.add(value.trim());
  };

  add(upstreamModel);
  add(def.modelId);
  add(def.id);
  add(def.name);

  const file = basename(def.modelPath);
  add(file);
  if (file.endsWith(".gguf")) add(file.slice(0, -5));

  return [...aliases];
}

export function gatewayModelId(def: ServerDefinition): string {
  const id = def.modelId;
  if (id.includes("/") && !id.startsWith("/") && !id.endsWith(".gguf")) return id;
  const file = basename(def.modelPath);
  if (file.endsWith(".gguf")) return file.slice(0, -5);
  return id || file || def.id;
}

export async function buildGatewayModelEntries(
  runtimes: InstanceRuntime[],
): Promise<GatewayModelEntry[]> {
  const entries: GatewayModelEntry[] = [];
  for (const rt of runtimes) {
    if (!rt.isRunning()) continue;
    const def = rt.definition;
    const upstreamModel = await rt.ensureInferenceModel();
    entries.push({
      id: gatewayModelId(def),
      serverId: def.id,
      serverName: def.name,
      upstreamModel,
      aliases: modelAliases(def, upstreamModel),
    });
  }
  return entries;
}

export function resolveGatewayRouteFromEntries(
  entries: GatewayModelEntry[],
  routes: GatewayRoute[],
  model?: string | null,
): GatewayRoute {
  if (routes.length === 0) {
    throw new GatewayRoutingError("No inference servers running", 503);
  }

  const routeByServerId = new Map(routes.map((r) => [r.serverId, r]));

  if (!model?.trim()) {
    if (routes.length === 1) return routes[0]!;
    const ids = entries.map((e) => e.id);
    throw new GatewayRoutingError(
      `Multiple servers running — specify model (available: ${ids.join(", ")})`,
      400,
    );
  }

  const key = normalizeModelKey(model);
  for (const entry of entries) {
    if (entry.aliases.some((alias) => normalizeModelKey(alias) === key)) {
      const route = routeByServerId.get(entry.serverId);
      if (route) return route;
    }
  }

  const ids = entries.map((e) => e.id);
  throw new GatewayRoutingError(
    `Unknown model "${model}" (available: ${ids.join(", ")})`,
    404,
  );
}

export function openAiModelsResponse(entries: GatewayModelEntry[]): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: entries.map((entry) => ({
      id: entry.id,
      object: "model",
      created,
      owned_by: "revolver",
    })),
  };
}

/** @internal exported for tests */
export { normalizeModelKey };
