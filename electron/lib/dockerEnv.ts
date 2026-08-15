import { join } from "path";
import { getRevolverRoot } from "./appRoot";
import { getDataDir } from "./config";
import { getGpuInfo } from "./gpu";

/** Default env for Electron. Docker CLI is used when a server's runtime is docker;
 * native servers spawn llama-server on the host instead. */
export function applyElectronDockerEnv(): void {
  process.env.REVOLVER_DOCKER = "1";
  if (!process.env.REVOLVER_ROOT) process.env.REVOLVER_ROOT = getRevolverRoot();
  if (!process.env.LLAMA_HOST) process.env.LLAMA_HOST = "127.0.0.1";
  if (!process.env.LLAMA_PORT) process.env.LLAMA_PORT = "8082";
  if (!process.env.LLAMA_CONTAINER) process.env.LLAMA_CONTAINER = "revolver-llama-server";
  if (!process.env.LLAMA_CONFIG_DIR) {
    process.env.LLAMA_CONFIG_DIR = join(getDataDir(), "llama-config");
  }
  if (process.env.LLAMA_GPU == null) {
    try {
      process.env.LLAMA_GPU = getGpuInfo().available ? "1" : "0";
    } catch {
      process.env.LLAMA_GPU = "0";
    }
  }
}
