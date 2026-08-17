import { spawnSync } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { delimiter, dirname, join } from "path";
import { getRevolverRoot } from "../electron/lib/appRoot";
import { inComposeBackend } from "../shared/runtimeMode";
import { installedMlxPython } from "./runtimeInstaller";

export interface MlxRuntimeResolve {
  available: boolean;
  python: string | null;
  error?: string;
}

const MLX_IMPORT_PROBE =
  "import importlib.util; assert importlib.util.find_spec('mlx_engine'); assert importlib.util.find_spec('revolver_mlx_server'); assert importlib.util.find_spec('mlx')";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canImportMlxEngine(python: string): boolean {
  const r = spawnSync(python, ["-c", MLX_IMPORT_PROBE], {
    timeout: 15_000,
    encoding: "utf8",
    cwd: dirname(python),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0;
}

function pathPythons(): string[] {
  const names = ["python3.13", "python3.12", "python3.11", "python3"];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      out.push(join(dir, name));
    }
  }
  return out;
}

export function resolveMlxPython(override?: string): MlxRuntimeResolve {
  if (process.platform !== "darwin") {
    return { available: false, python: null, error: "MLX is macOS only (Apple Silicon)" };
  }

  const candidates: string[] = [];
  if (override) candidates.push(override);
  if (process.env.MLX_PYTHON) candidates.push(process.env.MLX_PYTHON);
  const staged = installedMlxPython();
  if (staged) candidates.push(staged);
  candidates.push(join(getRevolverRoot(), "mlx", ".venv", "bin", "python"));
  candidates.push("/opt/homebrew/bin/python3.13");
  candidates.push("/opt/homebrew/bin/python3.12");
  candidates.push("/opt/homebrew/bin/python3.11");
  candidates.push(...pathPythons());

  const seen = new Set<string>();
  for (const python of candidates) {
    if (!python || seen.has(python)) continue;
    seen.add(python);
    if (!existsSync(python) || !isExecutable(python)) continue;
    if (canImportMlxEngine(python)) return { available: true, python };
  }

  return {
    available: false,
    python: null,
    error:
      "mlx-engine runtime not found. Install via Setup runtimes, or set MLX_PYTHON to a Python with mlx_engine + revolver_mlx_server.",
  };
}

export function probeMlxRuntime(override?: string): MlxRuntimeResolve {
  if (inComposeBackend()) {
    return {
      available: false,
      python: null,
      error:
        "MLX cannot run inside Docker Compose. Use Electron on the Mac host (native revolver_mlx_server).",
    };
  }
  return resolveMlxPython(override);
}
