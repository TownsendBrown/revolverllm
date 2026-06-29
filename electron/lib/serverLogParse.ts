import type { LoadProgress, ServerLoadPhase } from "./types";

const LOAD_STEPS: Array<{ id: string; label: string; test: (text: string) => boolean }> = [
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
    test: (t) => /model loaded|server is listening|\[revolver\] server ready/.test(t),
  },
];

export function parseLoadProgress(
  lines: string[],
  running: boolean,
  loadPhase: ServerLoadPhase,
  loadStartedAt?: number | null,
): LoadProgress | null {
  if (!running && loadPhase === "idle") return null;
  if (loadPhase === "inferring") return null;

  const text = lines.join("\n");
  const allReady = LOAD_STEPS[LOAD_STEPS.length - 1].test(text);
  const elapsedMs = loadStartedAt != null ? Date.now() - loadStartedAt : undefined;

  if (allReady) {
    return {
      percent: 100,
      stage: "Ready",
      steps: LOAD_STEPS.map((s) => ({ id: s.id, label: s.label, status: "done" as const })),
      elapsedMs,
    };
  }

  let highest = -1;
  for (let i = 0; i < LOAD_STEPS.length; i++) {
    if (LOAD_STEPS[i].test(text)) highest = i;
  }

  const steps = LOAD_STEPS.map((s, i) => {
    let status: "pending" | "active" | "done" = "pending";
    if (highest < 0) status = i === 0 ? "active" : "pending";
    else if (i < highest) status = "done";
    else if (i === highest) status = "active";
    return { id: s.id, label: s.label, status };
  });

  let percent =
    highest < 0 ? 5 : Math.min(92, Math.round(((highest + 0.35) / LOAD_STEPS.length) * 100));

  if (loadStartedAt != null && loadPhase === "loading") {
    const elapsed = Date.now() - loadStartedAt;
    const timeFloor = Math.min(92, 5 + (elapsed / 55_000) * 87);
    percent = Math.max(percent, Math.round(timeFloor));
    if (highest === 2) {
      percent = Math.max(percent, Math.min(78, 30 + Math.round((elapsed / 45_000) * 48)));
    }
  }

  const stage = steps.find((s) => s.status === "active")?.label ?? "Starting…";
  return { percent, stage, steps, elapsedMs };
}

const IMPORTANT =
  /\[revolver\]|model loaded|server is listening|print_timing|eval time|tokens per second|\btg\s*=\s*[\d.]+\s*t\/s|operator\(\): cleaning|exited|error|fatal/i;

export function filterLogLines(lines: string[], verbose: boolean): string[] {
  if (verbose) return lines;
  return lines.filter((l) => IMPORTANT.test(l));
}

export function parseLoadPhase(lines: string[], running: boolean): ServerLoadPhase {
  if (!running) return "idle";
  const all = lines.join("\n");
  const tail = lines.slice(-40).join("\n");
  if (/print_timing.*\beval time\b|n_decoded\s*=/.test(tail)) return "inferring";
  if (/model loaded|server is listening|\[revolver\] server ready/.test(all)) return "ready";
  if (
    /\[revolver\] loading|load_model: loading model|fitting params to device memory|llama_model_loader|setting token|warming up the model|initializing slots|new slot, n_ctx/.test(
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
