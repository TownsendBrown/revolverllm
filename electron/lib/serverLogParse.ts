import type { EngineId, LoadProgress, ServerLoadPhase } from "./types";

type LoadStep = { id: string; label: string; test: (text: string) => boolean };

const LLAMACPP_LOAD_STEPS: LoadStep[] = [
  {
    id: "spawn",
    label: "Starting server",
    test: (t) => /\[revolver\] loading|llama_server: loading model|load_model: loading model/.test(t),
  },
  {
    id: "fit",
    label: "GPU memory fit",
    test: (t) => /fitting params to device memory/.test(t),
  },
  {
    id: "weights",
    label: "Loading weights",
    test: (t) =>
      /llama_model_loader|load_tensors|tensor overrides|common_init_result|setting token/.test(t),
  },
  {
    id: "warmup",
    label: "Warmup",
    test: (t) => /warming up the model/.test(t),
  },
  {
    id: "slots",
    label: "Context slots",
    test: (t) => /initializing slots|new slot, n_ctx|prompt cache is enabled/.test(t),
  },
  {
    id: "ready",
    label: "Ready",
    test: (t) => /model loaded|server is listening|\[revolver\] ready on/.test(t),
  },
];

/** vLLM 0.9.x load phases (matches Desktop/VLLM docker healthcheck window). */
const VLLM_LOAD_STEPS: LoadStep[] = [
  {
    id: "spawn",
    label: "Starting vLLM",
    test: (t) => /vllm-legacy starting:|vllm starting:|api_server\.py/.test(t),
  },
  {
    id: "engine",
    label: "Initializing engine",
    test: (t) => /Initializing a V0 LLM engine|Started engine process/.test(t),
  },
  {
    id: "weights",
    label: "Loading weights",
    test: (t) => /Starting to load model|Loading safetensors checkpoint shards/.test(t),
  },
  {
    id: "profile",
    label: "KV cache / profiling",
    test: (t) => /Loading weights took|Memory profiling|init engine \(profile, create kv cache/.test(t),
  },
  {
    id: "serve",
    label: "Starting API server",
    test: (t) => /Starting vLLM API server|Started server process/.test(t),
  },
  {
    id: "ready",
    label: "Ready",
    test: (t) => /Application startup complete|\[revolver\] ready on/.test(t),
  },
];

const MLX_LOAD_STEPS: LoadStep[] = [
  {
    id: "spawn",
    label: "Starting MLX server",
    test: (t) => /revolver_mlx_server|\[native\] revolver_mlx_server/.test(t),
  },
  {
    id: "weights",
    label: "Loading weights",
    test: (t) => /Loading|Fetching|Downloaded|huggingface/i.test(t),
  },
  {
    id: "ready",
    label: "Ready",
    test: (t) => /Starting httpd at|\[revolver\] ready on/.test(t),
  },
];

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function loadStepsForEngine(engine?: EngineId | string | null): LoadStep[] {
  if (engine === "vllm" || engine === "vllm-legacy") return VLLM_LOAD_STEPS;
  if (engine === "mlx") return MLX_LOAD_STEPS;
  return LLAMACPP_LOAD_STEPS;
}

function loadTimeBudgetMs(engine?: EngineId | string | null): number {
  if (engine === "vllm" || engine === "vllm-legacy") return 180_000;
  if (engine === "mlx") return 120_000;
  return 55_000;
}

export function parseLoadProgress(
  lines: string[],
  running: boolean,
  loadPhase: ServerLoadPhase,
  loadStartedAt?: number | null,
  engine?: EngineId | string | null,
): LoadProgress | null {
  if (!running && loadPhase === "idle") return null;
  if (loadPhase === "inferring") return null;

  const stepsDef = loadStepsForEngine(engine);
  const text = stripAnsi(lines.join("\n"));
  const allReady = stepsDef[stepsDef.length - 1].test(text);
  const elapsedMs = loadStartedAt != null ? Date.now() - loadStartedAt : undefined;

  if (allReady) {
    return {
      percent: 100,
      stage: "Ready",
      steps: stepsDef.map((s) => ({ id: s.id, label: s.label, status: "done" as const })),
      elapsedMs,
    };
  }

  let highest = -1;
  for (let i = 0; i < stepsDef.length; i++) {
    if (stepsDef[i].test(text)) highest = i;
  }

  const steps = stepsDef.map((s, i) => {
    let status: "pending" | "active" | "done" = "pending";
    if (highest < 0) status = i === 0 ? "active" : "pending";
    else if (i < highest) status = "done";
    else if (i === highest) status = "active";
    return { id: s.id, label: s.label, status };
  });

  let percent =
    highest < 0 ? 5 : Math.min(92, Math.round(((highest + 0.35) / stepsDef.length) * 100));

  if (loadStartedAt != null && loadPhase === "loading") {
    const elapsed = Date.now() - loadStartedAt;
    const budget = loadTimeBudgetMs(engine);
    const timeFloor = Math.min(92, 5 + (elapsed / budget) * 87);
    percent = Math.max(percent, Math.round(timeFloor));
    const weightsIdx = stepsDef.findIndex((s) => s.id === "weights");
    if (highest === weightsIdx && weightsIdx >= 0) {
      percent = Math.max(percent, Math.min(85, 25 + Math.round((elapsed / budget) * 60)));
    }
  }

  const stage = steps.find((s) => s.status === "active")?.label ?? "Starting…";
  return { percent, stage, steps, elapsedMs };
}

const IMPORTANT =
  /\[revolver\]|model loaded|server is listening|print_timing|eval time|tokens per second|\btg\s*=\s*[\d.]+\s*t\/s|operator\(\): cleaning|exited|error|fatal|Starting to load model|Loading safetensors|Application startup complete|Starting vLLM API server|Starting httpd at|revolver_mlx_server|listening on http/i;

export function filterLogLines(lines: string[], verbose: boolean): string[] {
  if (verbose) return lines;
  return lines.filter((l) => IMPORTANT.test(l));
}

export function parseLoadPhase(lines: string[], running: boolean): ServerLoadPhase {
  if (!running) return "idle";
  const all = stripAnsi(lines.join("\n"));
  const tail = stripAnsi(lines.slice(-40).join("\n"));
  if (/print_timing.*\beval time\b|n_decoded\s*=/.test(tail)) return "inferring";
  if (/model loaded|server is listening|\[revolver\] ready on|Application startup complete/.test(all)) {
    return "ready";
  }
  if (
    /\[revolver\] loading|load_model: loading model|fitting params to device memory|llama_model_loader|setting token|warming up the model|initializing slots|new slot, n_ctx|Starting to load model|Initializing a V0 LLM engine/.test(
      all,
    )
  ) {
    return "loading";
  }
  return running ? "loading" : "idle";
}

export function parseLastSpeedTps(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const tg = lines[i].match(/\btg\s*=\s*([\d.]+)\s*t\/s/i);
    if (tg) return Number(tg[1]);
    const tps = lines[i].match(/([\d.]+)\s+tokens per second/i);
    if (tps) return Number(tps[1]);
  }
  return null;
}
