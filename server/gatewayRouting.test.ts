import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerDefinition } from "../shared/types";
import {
  GatewayRoutingError,
  gatewayModelId,
  modelAliases,
  openAiModelsResponse,
  resolveGatewayRouteFromEntries,
  type GatewayModelEntry,
  type GatewayRoute,
} from "./gatewayRouting";

function fakeDef(overrides: Partial<ServerDefinition> & Pick<ServerDefinition, "id">): ServerDefinition {
  return {
    name: "test-server",
    engine: "llamacpp",
    backend: "cuda",
    gpuDevices: [],
    gpuMode: "single",
    modelId: "Qwen/Qwen3-8B-GGUF",
    modelPath: "/models/Qwen3-8B-Q4_K_M.gguf",
    mmprojPath: null,
    contextLength: 8192,
    nGpuLayers: -1,
    kvCacheDtype: "f16",
    engineConfig: {},
    hostPort: 8082,
    apiKey: null,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("gatewayRouting", () => {
  it("gatewayModelId prefers huggingface-style modelId", () => {
    assert.equal(gatewayModelId(fakeDef({ id: "abc" })), "Qwen/Qwen3-8B-GGUF");
  });

  it("gatewayModelId falls back to gguf basename", () => {
    const def = fakeDef({
      id: "abc",
      modelId: "/models/foo.gguf",
      modelPath: "/models/MyModel-Q4.gguf",
    });
    assert.equal(gatewayModelId(def), "MyModel-Q4");
  });

  it("modelAliases includes upstream, modelId, filename, and local", () => {
    const def = fakeDef({ id: "srv1" });
    const aliases = modelAliases(def, "local");
    assert.ok(aliases.includes("local"));
    assert.ok(aliases.includes("Qwen/Qwen3-8B-GGUF"));
    assert.ok(aliases.includes("Qwen3-8B-Q4_K_M.gguf"));
    assert.ok(aliases.includes("Qwen3-8B-Q4_K_M"));
  });

  it("resolveGatewayRouteFromEntries routes by gateway model id", () => {
    const entries: GatewayModelEntry[] = [
      {
        id: "Qwen/Qwen3-8B-GGUF",
        serverId: "srv1",
        serverName: "qwen",
        upstreamModel: "local",
        aliases: modelAliases(fakeDef({ id: "srv1" }), "local"),
      },
    ];
    const routes: GatewayRoute[] = [
      {
        host: "127.0.0.1",
        port: 8082,
        upstreamModel: "local",
        apiKey: null,
        serverId: "srv1",
        markActivity: () => {},
      },
    ];
    const route = resolveGatewayRouteFromEntries(entries, routes, "Qwen/Qwen3-8B-GGUF");
    assert.equal(route.serverId, "srv1");
    assert.equal(route.upstreamModel, "local");
  });

  it("resolveGatewayRouteFromEntries uses sole running server when model omitted", () => {
    const entries: GatewayModelEntry[] = [
      {
        id: "only-model",
        serverId: "srv1",
        serverName: "only",
        upstreamModel: "local",
        aliases: ["local", "only-model"],
      },
    ];
    const routes: GatewayRoute[] = [
      {
        host: "127.0.0.1",
        port: 8082,
        upstreamModel: "local",
        apiKey: null,
        serverId: "srv1",
        markActivity: () => {},
      },
    ];
    const route = resolveGatewayRouteFromEntries(entries, routes, undefined);
    assert.equal(route.serverId, "srv1");
  });

  it("resolveGatewayRouteFromEntries errors when multiple servers and no model", () => {
    const entries: GatewayModelEntry[] = [
      {
        id: "a",
        serverId: "1",
        serverName: "a",
        upstreamModel: "local",
        aliases: ["a"],
      },
      {
        id: "b",
        serverId: "2",
        serverName: "b",
        upstreamModel: "local",
        aliases: ["b"],
      },
    ];
    const routes: GatewayRoute[] = [
      {
        host: "127.0.0.1",
        port: 8082,
        upstreamModel: "local",
        apiKey: null,
        serverId: "1",
        markActivity: () => {},
      },
      {
        host: "127.0.0.1",
        port: 8083,
        upstreamModel: "local",
        apiKey: null,
        serverId: "2",
        markActivity: () => {},
      },
    ];
    assert.throws(
      () => resolveGatewayRouteFromEntries(entries, routes, ""),
      (e: unknown) => e instanceof GatewayRoutingError && e.status === 400,
    );
  });

  it("openAiModelsResponse lists gateway model ids", () => {
    const body = openAiModelsResponse([
      {
        id: "Qwen/Qwen3-8B-GGUF",
        serverId: "srv1",
        serverName: "qwen",
        upstreamModel: "local",
        aliases: [],
      },
    ]);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0]?.id, "Qwen/Qwen3-8B-GGUF");
  });
});
