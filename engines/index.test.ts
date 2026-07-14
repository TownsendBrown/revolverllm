import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ENGINE,
  enginesForFormat,
  enginesForModel,
  engineInfos,
  getEngine,
  listEngines,
} from "./index";
import { buildVllmLegacyLoadEnv, normalizeLegacyDtype } from "./vllm-legacy/config";
import { buildVllmLoadEnv } from "./vllm/config";
import { resolveGgufTokenizer, resolveVllmTokenizerMode } from "./vllm/ggufTokenizer";
import type { ServerDefinition } from "../shared/types";
import { parseLoadProgress } from "../electron/lib/serverLogParse";

describe("engine registry", () => {
  it("registers llama.cpp, vLLM, and vLLM Legacy", () => {
    const ids = listEngines().map((e) => e.id).sort();
    assert.deepEqual(ids, ["llamacpp", "vllm", "vllm-legacy"]);
  });

  it("defaults to llama.cpp for legacy definitions", () => {
    assert.equal(getEngine(undefined).id, "llamacpp");
    assert.equal(getEngine(null).id, "llamacpp");
    assert.equal(DEFAULT_ENGINE, "llamacpp");
  });

  it("exposes serializable engine metadata", () => {
    const infos = engineInfos();
    assert.equal(infos.length, 3);
    assert.ok(infos.every((i) => i.capabilities.api === "openai"));
  });
});

describe("model compatibility", () => {
  it("maps GGUF to llama.cpp and modern vLLM only", () => {
    assert.deepEqual(enginesForFormat("gguf").sort(), ["llamacpp", "vllm"]);
  });

  it("maps AWQ/GPTQ to vLLM only", () => {
    for (const fmt of ["awq", "gptq"] as const) {
      assert.deepEqual(enginesForFormat(fmt), ["vllm"]);
    }
  });

  it("maps safetensors to vLLM and vLLM Legacy", () => {
    assert.deepEqual(enginesForFormat("safetensors").sort(), ["vllm", "vllm-legacy"]);
  });

  it("validates llama.cpp requires local GGUF", () => {
    const llama = getEngine("llamacpp");
    assert.equal(llama.validateModel({ format: "gguf", source: "local" }), null);
    assert.match(llama.validateModel({ format: "awq", source: "local" }) ?? "", /GGUF/);
    assert.match(llama.validateModel({ format: "gguf", source: "huggingface" }) ?? "", /local/);
  });

  it("validates vLLM Pascal safetensors only", () => {
    const legacy = getEngine("vllm-legacy");
    assert.equal(legacy.validateModel({ id: "meta/Llama-3-8B", format: "safetensors", source: "local", path: "/models/meta/Llama-3-8B" }), null);
    assert.equal(legacy.validateModel({ id: "org/model", format: "safetensors", source: "huggingface", path: "org/model" }), null);
    assert.match(
      legacy.validateModel({ id: "/models/foo.gguf", format: "gguf", source: "local", path: "/models/foo.gguf" }) ?? "",
      /safetensors only|llama\.cpp/i,
    );
    assert.match(legacy.validateModel({ id: "openai/gpt-oss-20b", format: "safetensors", source: "huggingface", path: "openai/gpt-oss-20b" }) ?? "", /gpt-oss/);
    assert.match(legacy.validateModel({ id: "awq", format: "awq", source: "local", path: "/m" }) ?? "", /safetensors only/);
    assert.equal(legacy.supportsBackend("cuda"), true);
    assert.equal(legacy.supportsBackend("metal"), false);
    assert.deepEqual(legacy.capabilities.formats, ["safetensors"]);
  });

  it("excludes vLLM Pascal from gpt-oss safetensors catalog compatibility", () => {
    assert.deepEqual(
      enginesForModel({
        format: "safetensors",
        modelId: "openai/gpt-oss-20b",
        modelType: "gpt_oss",
      }),
      ["vllm"],
    );
    assert.deepEqual(
      enginesForModel({
        format: "gguf",
        modelId: "/models/gemma-4-12b.gguf",
        modelType: "gemma4",
        architectures: ["gemma4"],
      }),
      ["llamacpp", "vllm"],
    );
    assert.deepEqual(
      enginesForModel({
        format: "safetensors",
        modelId: "mistralai/Mistral-7B-v0.1",
        modelType: "mistral",
      }).sort(),
      ["vllm", "vllm-legacy"],
    );
  });

  it("validates vLLM HF formats and local GGUF", () => {
    const vllm = getEngine("vllm");
    assert.equal(vllm.validateModel({ format: "awq", source: "local" }), null);
    assert.equal(vllm.validateModel({ format: "safetensors", source: "huggingface" }), null);
    assert.match(
      vllm.validateModel({ id: "/models/foo.gguf", format: "gguf", source: "local", path: "/models/foo.gguf" }) ?? "",
      /tokenizer|llama\.cpp/i,
    );
    assert.match(vllm.validateModel({ format: "gguf", source: "huggingface", path: "org/model" }) ?? "", /local/);
    assert.equal(vllm.supportsBackend("cuda"), true);
    assert.equal(vllm.supportsBackend("metal"), false);
  });
});

describe("vLLM Pascal load env", () => {
  it("coerces legacy dtype values to FP16", () => {
    assert.equal(normalizeLegacyDtype("auto"), "half");
    assert.equal(normalizeLegacyDtype("bfloat16"), "half");
    assert.equal(normalizeLegacyDtype("half"), "half");
    assert.equal(normalizeLegacyDtype("float16"), "float16");
    assert.equal(normalizeLegacyDtype("float"), "float");
    assert.equal(normalizeLegacyDtype("float32"), "float");
  });

  it("forces float32 for Gemma 2 on Pascal", () => {
    assert.equal(normalizeLegacyDtype("half", { forceFloat32: true }), "float");
    assert.equal(normalizeLegacyDtype("float16", { forceFloat32: true }), "float");
    assert.equal(normalizeLegacyDtype("auto", { forceFloat32: true }), "float");
    assert.equal(normalizeLegacyDtype("bfloat16", { forceFloat32: true }), "float");
    assert.equal(normalizeLegacyDtype(undefined, { forceFloat32: true }), "float");
  });

  it("forces FP16 weights and eager mode in load env", () => {
    const def = {
      id: "abc",
      name: "test",
      engine: "vllm-legacy",
      backend: "cuda",
      gpuDevices: [0],
      gpuMode: "single",
      modelId: "org/model",
      modelPath: "/models/org/model",
      contextLength: 4096,
      engineConfig: { dtype: "auto", gpu_memory_utilization: 0.9, modelFormat: "safetensors" },
    } as ServerDefinition;
    const plan = buildVllmLegacyLoadEnv(def);
    assert.equal(plan.env.DTYPE, "half");
    assert.equal(plan.env.QUANTIZATION, undefined);
    assert.equal(plan.env.ENFORCE_EAGER, "1");
    assert.equal(plan.env.KV_CACHE_DTYPE, undefined);
  });

  it("uses float32 for Gemma 2 safetensors on Pascal", () => {
    const def = {
      id: "gemma",
      name: "gemma",
      engine: "vllm-legacy",
      backend: "cuda",
      gpuDevices: [0],
      gpuMode: "single",
      modelId: "google/gemma-2-2b-it",
      modelPath: "/models/google/gemma-2-2b-it",
      contextLength: 2048,
      engineConfig: { dtype: "half", modelFormat: "safetensors", modelSource: "local" },
    } as ServerDefinition;
    const plan = buildVllmLegacyLoadEnv(def);
    assert.equal(plan.env.DTYPE, "float");
    assert.equal(plan.env.ENFORCE_EAGER, "1");
  });

  it("sets slow tokenizer mode from model id for safetensors", () => {
    const def = {
      id: "mistral-st",
      name: "test",
      engine: "vllm-legacy",
      backend: "cuda",
      gpuDevices: [0],
      gpuMode: "single",
      modelId: "mistralai/Mistral-7B-Instruct-v0.2",
      modelPath: "/models/mistralai/Mistral-7B-Instruct-v0.2",
      contextLength: 4096,
      engineConfig: { modelFormat: "safetensors", modelSource: "huggingface" },
    } as ServerDefinition;
    const plan = buildVllmLegacyLoadEnv(def);
    assert.equal(plan.env.TOKENIZER_MODE, "slow");
    assert.equal(resolveVllmTokenizerMode("/models/foo.gguf", { tokenizer: "mistralai/Mistral-7B" }), "slow");
    assert.equal(resolveVllmTokenizerMode("/models/foo.gguf", { tokenizer: "mistralai/Mistral-Small-3.1" }), "mistral");
  });

  it("sets GGUF quantization for modern vLLM", () => {
    const def = {
      id: "gguf",
      name: "test",
      engine: "vllm",
      backend: "cuda",
      gpuDevices: [0],
      gpuMode: "single",
      modelId: "/models/foo.gguf",
      modelPath: "/models/foo.gguf",
      contextLength: 4096,
      engineConfig: { dtype: "float16", modelFormat: "gguf", modelSource: "local" },
    } as ServerDefinition;
    const plan = buildVllmLoadEnv(def);
    assert.equal(plan.env.QUANTIZATION, "gguf");
    assert.equal(plan.env.DTYPE, undefined);
  });

  it("resolves HuggingFace tokenizer for Mistral GGUF on modern vLLM", () => {
    const path =
      "/home/ape/models/Mistral-7B-Instruct-v0.2/mistral-7b-instruct-v0.2.Q4_K_M.gguf";
    assert.equal(resolveGgufTokenizer(path), "mistralai/Mistral-7B-Instruct-v0.2");
  });

  it("parses vLLM load progress from container logs", () => {
    const lines = [
      "[revolver] starting server",
      "vllm-legacy starting: model=/models/Qwen/Qwen2-7B-Instruct dtype=half",
      "INFO Initializing a V0 LLM engine (v0.9.1)",
      "INFO Starting to load model /models/Qwen/Qwen2-7B-Instruct...",
      "Loading safetensors checkpoint shards: 100% Completed",
      "INFO Loading weights took 53.96 seconds",
      "INFO init engine (profile, create kv cache, warmup model) took 16.54 seconds",
      "INFO Starting vLLM API server 0 on http://0.0.0.0:8000",
    ];
    const progress = parseLoadProgress(lines, true, "loading", Date.now() - 60_000, "vllm-legacy");
    assert.ok(progress);
    assert.equal(progress!.stage, "Starting API server");
    assert.ok(progress!.percent >= 70);
  });
});
