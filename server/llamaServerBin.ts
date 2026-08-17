import { accessSync, constants, existsSync, readdirSync } from "fs";
import { delimiter, join } from "path";
import { homedir } from "os";
import { inComposeBackend } from "../shared/runtimeMode";
import { resolveInstalledBackendPack, type NativeBackendResolve } from "./nativeBackends";
import { installedLlamaServerBin } from "./runtimeInstaller";

export interface LlamaServerResolve {
  bin: string | null;
  libDir?: string | null;
  packId?: string | null;
  error?: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function scoreCandidate(path: string): number {
  const p = path.toLowerCase();
  if (/v100|volta|sm70|sm_70/.test(p)) return 40;
  if (/nvidia-cuda|cuda/.test(p)) return 30;
  if (/rocm|hip/.test(p)) return 20;
  if (/vulkan/.test(p)) return 10;
  return 0;
}

function lmStudioServerBins(home: string): string[] {
  const roots = [join(home, ".lmstudio", "extensions", "backends")];
  const llmster = join(home, ".lmstudio", "llmster");
  if (existsSync(llmster)) {
    try {
      for (const name of readdirSync(llmster)) {
        roots.push(join(llmster, name, ".bundle", "bin", "extensions", "backends"));
      }
    } catch {
      /* ignore */
    }
  }
  const found: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root)) {
        const bin = join(root, name, "llama-server");
        if (existsSync(bin)) found.push(bin);
      }
    } catch {
      /* ignore */
    }
  }
  return found.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

export function extraLlamaServerCandidates(home = homedir()): string[] {
  return [
    join(home, ".local", "bin", "llama-server"),
    ...lmStudioServerBins(home),
  ];
}

export interface ResolveLlamaServerOpts {
  pack?: NativeBackendResolve | null;
  skipPacks?: boolean;
  platform?: NodeJS.Platform;
  home?: string;
}

function missingBinError(): string {
  if (process.platform === "darwin") {
    return "llama.cpp runtime not installed — install it from Setup runtimes (downloads the Metal build from GitHub releases).";
  }
  return "llama-server not found. Build a CUDA pack: ./backends/build.sh sm70 — then npm run install:llama-server. Or set LLAMA_SERVER_BIN.";
}

export function resolveLlamaServerBin(
  override?: string,
  opts?: ResolveLlamaServerOpts,
): LlamaServerResolve {
  if (override && existsSync(override) && isExecutable(override)) {
    return { bin: override };
  }

  const envBin = process.env.LLAMA_SERVER_BIN;
  if (envBin && existsSync(envBin) && isExecutable(envBin)) {
    return { bin: envBin };
  }

  const platform = opts?.platform ?? process.platform;
  if (platform !== "darwin" && !opts?.skipPacks) {
    const pack = opts?.pack !== undefined ? opts.pack : resolveInstalledBackendPack({ platform });
    if (pack) {
      return { bin: pack.bin, libDir: pack.libDir, packId: pack.packId };
    }
  }

  const home = opts?.home ?? homedir();
  const staged = platform === "darwin" ? installedLlamaServerBin() : null;
  const candidates = [
    ...(staged ? [staged] : []),
    ...pathDirs().flatMap((dir) => [join(dir, "llama-server"), join(dir, "llama-server-cuda")]),
    "/usr/local/bin/llama-server",
    "/opt/homebrew/bin/llama-server",
    "/usr/bin/llama-server",
    ...extraLlamaServerCandidates(home),
  ];

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (existsSync(candidate) && isExecutable(candidate)) return { bin: candidate };
  }

  return { bin: null, error: missingBinError() };
}

export function probeNativeRuntime(
  override?: string,
  opts?: ResolveLlamaServerOpts,
): {
  available: boolean;
  bin: string | null;
  libDir?: string | null;
  packId?: string | null;
  error?: string;
} {
  if (inComposeBackend()) {
    return {
      available: false,
      bin: null,
      error:
        "Native inference is not available inside Docker Compose. Use the Electron app, or spawn llama-server on the host.",
    };
  }
  const found = resolveLlamaServerBin(override, opts);
  return {
    available: Boolean(found.bin),
    bin: found.bin,
    libDir: found.libDir,
    packId: found.packId,
    error: found.error,
  };
}
