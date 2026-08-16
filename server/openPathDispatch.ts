import { loadConfig } from "../electron/lib/config";
import { openPathOnHost, resolveHostPath } from "../shared/openPath";
import { hostAgentCall, metalEnabled } from "./hostAgent";
import { hostOpenAgentCall, hostOpenAgentEnabled } from "./hostOpenAgent";

export type OpenPathFn = (hostPath: string) => Promise<string>;

let nativeOpener: OpenPathFn | null = null;

/** Electron registers shell.openPath here; server uses spawn-based openPathOnHost. */
export function setNativeOpenPathOpener(opener: OpenPathFn | null): void {
  nativeOpener = opener;
}

/** True when this runtime can reach the host file manager. */
export function canDispatchOpenPath(): boolean {
  if (nativeOpener) return true;
  if (hostOpenAgentEnabled()) return true;
  if (metalEnabled()) return true;
  if (process.env.REVOLVER_DOCKER === "1") return false;
  return true;
}

async function openViaHostAgent(hostPath: string): Promise<string> {
  if (metalEnabled()) {
    return hostAgentCall<string>("openPath", { path: hostPath });
  }
  if (hostOpenAgentEnabled()) {
    return hostOpenAgentCall<string>("openPath", { path: hostPath });
  }
  throw new Error("No host agent configured");
}

export async function dispatchOpenPath(configPath: string): Promise<string> {
  const cfg = loadConfig();
  const hostPath = resolveHostPath(configPath, cfg);

  if (nativeOpener) {
    return nativeOpener(hostPath);
  }

  if (hostOpenAgentEnabled() || metalEnabled()) {
    try {
      return await openViaHostAgent(hostPath);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  if (process.env.REVOLVER_DOCKER === "1") {
    return "Open folder unavailable — start the host open agent (npm run docker:up)";
  }

  return openPathOnHost(hostPath);
}
