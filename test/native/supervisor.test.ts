import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createServer } from "net";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { NativeSupervisor } from "../../server/nativeSupervisor";
import { llamaEnvFileName } from "../../engines/llamacpp/docker";
import { claimGpus, resetGpuClaims } from "../../server/gpuClaims";

const MOCK_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "mock-llama-server.mjs");
const NODE = process.execPath;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mock llama-server not healthy on ${port}: ${last}`);
}

function writeLoadEnv(configDir: string, serverId: string, env: Record<string, string>): void {
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(join(configDir, llamaEnvFileName(serverId)), `${body}\n`);
}

describe("NativeSupervisor multi-instance", () => {
  const configDir = mkdtempSync(join(tmpdir(), "revolver-native-"));
  const modelPath = join(configDir, "dummy.gguf");
  writeFileSync(modelPath, "GGUF");
  mkdirSync(configDir, { recursive: true });

  const shim = join(configDir, "llama-server-shim.sh");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${NODE}" "${MOCK_BIN}" "$@"\n`,
    { mode: 0o755 },
  );

  const native = new NativeSupervisor({
    configDir,
    llamaServerBin: shim,
  });

  const ids: string[] = [];

  after(async () => {
    for (const id of ids) await native.stop(id);
    resetGpuClaims();
  });

  it("starts two processes on different ports with distinct CUDA_VISIBLE_DEVICES", async () => {
    const portA = await freePort();
    const portB = await freePort();
    const idA = "gpu0";
    const idB = "gpu1";
    ids.push(idA, idB);

    writeLoadEnv(configDir, idA, {
      MODEL_PATH: modelPath,
      LLAMA_PORT: String(portA),
      BACKEND: "cuda",
      CUDA_VISIBLE_DEVICES: "0",
    });
    writeLoadEnv(configDir, idB, {
      MODEL_PATH: modelPath,
      LLAMA_PORT: String(portB),
      BACKEND: "cuda",
      CUDA_VISIBLE_DEVICES: "1",
    });

    claimGpus({
      id: idA,
      name: "gpu0",
      backend: "cuda",
      gpuDevices: [0],
      gpuMode: "single",
    });
    claimGpus({
      id: idB,
      name: "gpu1",
      backend: "cuda",
      gpuDevices: [1],
      gpuMode: "single",
    });
    assert.throws(
      () =>
        claimGpus({
          id: "gpu0-again",
          name: "overlap",
          backend: "cuda",
          gpuDevices: [0],
          gpuMode: "single",
        }),
      /GPU 0/,
    );

    const a = await native.restart(idA, portA);
    const b = await native.restart(idB, portB);
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    assert.ok(a.pid);
    assert.ok(b.pid);
    assert.notEqual(a.pid, b.pid);

    await waitForHealth(portA);
    await waitForHealth(portB);

    const logsA = native.logs(idA).join("\n");
    const logsB = native.logs(idB).join("\n");
    assert.match(logsA, /CUDA_VISIBLE_DEVICES=0/);
    assert.match(logsB, /CUDA_VISIBLE_DEVICES=1/);
    assert.match(logsA, /HTTP server listening/);
    assert.match(logsB, /HTTP server listening/);

    const models = await fetch(`http://127.0.0.1:${portA}/v1/models`);
    assert.equal(models.ok, true);

    await native.stop(idA);
    assert.equal(native.inspect(idA).status, "stopped");
    await native.stop(idB);
  });

  it("stays idle when MODEL_PATH is missing", async () => {
    const id = "idle";
    ids.push(id);
    writeLoadEnv(configDir, id, { BACKEND: "cpu" });
    const inspect = await native.restart(id, await freePort());
    assert.equal(inspect.status, "idle");
    assert.equal(inspect.pid, null);
  });
});
