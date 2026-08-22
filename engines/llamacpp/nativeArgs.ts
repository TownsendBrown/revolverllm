/** JS port of LLAMA_ENTRYPOINT_SCRIPT flag building for native spawn (Windows). */

export function truthyFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "on" || v === "true" || v === "yes";
}

export function falsyFlag(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "0" || v === "off" || v === "false" || v === "no";
}

export function buildLlamaServerArgs(env: Record<string, string>, hostPort: number): string[] {
  const host = env.LLAMA_HOST || "127.0.0.1";
  const port = env.LLAMA_PORT || String(hostPort);
  const model = env.MODEL_PATH || env.MODEL || "";
  const backend = env.BACKEND || "cpu";
  let gpuLayers = env.N_GPU_LAYERS ?? "";
  if ((!gpuLayers || gpuLayers === "0") && backend === "metal") {
    gpuLayers = "-1";
  }

  const args = ["--host", host, "--port", port, "--model", model];
  const ctx = env.CTX_SIZE;
  if (ctx) args.push("--ctx-size", ctx);
  if (gpuLayers) args.push("--n-gpu-layers", gpuLayers);
  if (env.MMPROJ_PATH) args.push("--mmproj", env.MMPROJ_PATH);
  if (env.FLASH_ATTN) args.push("--flash-attn", env.FLASH_ATTN);
  if (env.CACHE_TYPE_K) args.push("--cache-type-k", env.CACHE_TYPE_K);
  if (env.CACHE_TYPE_V) args.push("--cache-type-v", env.CACHE_TYPE_V);
  if (env.N_PARALLEL) args.push("--parallel", env.N_PARALLEL);
  if (env.REASONING) args.push("--reasoning", env.REASONING);
  if (env.REASONING_FORMAT) args.push("--reasoning-format", env.REASONING_FORMAT);
  if (env.API_KEY) args.push("--api-key", env.API_KEY);
  if (truthyFlag(env.KV_UNIFIED)) args.push("--kv-unified");
  if (!falsyFlag(env.JINJA ?? "on")) args.push("--jinja");
  return args;
}

export function llamaStartLogLine(env: Record<string, string>, model: string): string {
  const backend = env.BACKEND || "cpu";
  return (
    `llama-server starting: backend=${backend} model=${model}` +
    ` ctx=${env.CTX_SIZE || "default"} gpu_layers=${env.N_GPU_LAYERS || "0"}` +
    ` flash_attn=${env.FLASH_ATTN || "default"} kv=${env.CACHE_TYPE_K || "f16"}` +
    ` parallel=${env.N_PARALLEL || "auto"} reasoning=${env.REASONING || "auto"}` +
    ` reasoning_format=${env.REASONING_FORMAT || "auto"} kv_unified=${env.KV_UNIFIED || "default"}`
  );
}
