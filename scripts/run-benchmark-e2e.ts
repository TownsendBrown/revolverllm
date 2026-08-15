#!/usr/bin/env tsx
/**
 * End-to-end benchmark smoke test against a running Revolver backend.
 *
 * Usage:
 *   REVOLVER_API=http://127.0.0.1:3001 tsx scripts/run-benchmark-e2e.ts
 *
 * Env:
 *   MODEL_PATH     — GGUF path (default: gpt-oss-20b under MODELS_DIR)
 *   GPU_DEVICE     — GPU index (default: 0)
 *   CONTEXT_LENGTH — context window (default: model max / 131072)
 *   TEST_IDS       — comma-separated test ids (default: evalplus)
 *   SKIP_SERVER    — set to 1 to reuse an existing running server
 */
import { readGgufMetadataCached } from "../electron/lib/ggufMetadata.ts";

const API = process.env.REVOLVER_API ?? "http://127.0.0.1:3001";
const MODELS_DIR = process.env.MODELS_DIR ?? "/home/ape/models";
const MODEL_PATH =
  process.env.MODEL_PATH ?? `${MODELS_DIR}/gpt-oss-20b/gpt-oss-20b-Q4_K_M.gguf`;
const GPU_DEVICE = Number(process.env.GPU_DEVICE ?? "0");
const TEST_IDS = (process.env.TEST_IDS ?? "evalplus").split(",").map((s) => s.trim());
const SKIP_SERVER = process.env.SKIP_SERVER === "1";

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body != null ? { "Content-Type": "application/json" } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function waitForServerReady(serverId: string, timeoutMs = 600_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await api<{ running: boolean; loadPhase: string; loaded: unknown }>(
      "GET",
      `/api/server/status?id=${encodeURIComponent(serverId)}`,
    );
    process.stdout.write(`\r  loadPhase=${st.loadPhase} running=${st.running}   `);
    if (st.running && st.loadPhase === "ready" && st.loaded) {
      console.log("\n  server ready");
      return;
    }
    if (st.loadPhase === "error") throw new Error("Server failed to load model");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for server");
}

async function waitForBenchmark(runId: string, timeoutMs = 1_800_000): Promise<unknown> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const run = await api<{ status: string; results: Array<{ testId: string; status: string; automatedScore: number | null }> }>(
      "GET",
      `/api/benchmarks/runs/${encodeURIComponent(runId)}`,
    );
    const progress = run.results.map((r) => `${r.testId}:${r.status}`).join(" ");
    process.stdout.write(`\r  benchmark ${run.status} — ${progress}   `);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      console.log("");
      return run;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("Timed out waiting for benchmark");
}

async function main(): Promise<void> {
  console.log(`API=${API}`);
  console.log(`Model=${MODEL_PATH}`);
  console.log(`GPU=${GPU_DEVICE}`);

  await api("GET", "/health");
  console.log("backend ok");

  let metaCtx = 131072;
  try {
    const meta = await readGgufMetadataCached(MODEL_PATH);
    metaCtx = Number(meta.contextLength) || 131072;
    console.log(`model context_length=${metaCtx} arch=${meta.arch}`);
  } catch (e) {
    console.warn(`metadata read failed: ${e}`);
  }

  const contextLength = Number(process.env.CONTEXT_LENGTH ?? metaCtx);
  console.log(`using contextLength=${contextLength}`);

  let serverId: string;

  if (SKIP_SERVER) {
    const servers = await api<Array<{ definition: { id: string }; running: boolean; loadPhase: string }>>(
      "GET",
      "/api/servers",
    );
    const running = servers.find((s) => s.running && s.loadPhase === "ready");
    if (!running) throw new Error("No running server — unset SKIP_SERVER or start one");
    serverId = running.definition.id;
    console.log(`reusing server ${serverId}`);
  } else {
    console.log("creating server…");
    const created = await api<{ definition: { id: string } }>("POST", "/api/servers", {
      name: "benchmark-gpt-oss-20b",
      modelId: MODEL_PATH,
      backend: "cuda",
      gpuDevices: [GPU_DEVICE],
      contextLength,
      nGpuLayers: 999,
      force: true,
    });
    serverId = created.definition.id;
    console.log(`serverId=${serverId}`);
    await waitForServerReady(serverId);
  }

  console.log(`starting benchmark tests: ${TEST_IDS.join(", ")}`);
  const run = await api<{ id: string }>("POST", "/api/benchmarks/runs", {
    serverId,
    testIds: TEST_IDS,
    enableThinking: false,
  });
  console.log(`runId=${run.id}`);

  const final = await waitForBenchmark(run.id);
  console.log(JSON.stringify(final, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
