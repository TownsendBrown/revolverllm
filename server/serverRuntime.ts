import type { ServerDefinition } from "../shared/types";
import { getEngine } from "../engines";
import { inComposeBackend, isNativeRuntime } from "../shared/runtimeMode";
import {
  ensureServerContainer,
  fetchContainerLogs,
  getContainerStartedAt,
  inspectContainerStatus,
  removeServerContainer,
  restartServerContainer,
  stopServerContainer,
} from "./containerUtils";
import { hostAgentCall, isMetalBackend, metalEnabled } from "./hostAgent";
import { getNativeSupervisor } from "./nativeSupervisor";
import { probeNativeRuntime } from "./llamaServerBin";

const HOST_AGENT_FAST_MS = 10_000;
const HOST_AGENT_SLOW_MS = 120_000;

interface ServerInspect {
  serverId: string;
  hostPort: number;
  status: "idle" | "starting" | "running" | "stopped" | "crashed";
  pid: number | null;
  startedAt: string | null;
}

function assertNativeAllowed(): string {
  if (inComposeBackend()) {
    throw new Error(
      "Native inference is not available inside Docker Compose. Use Docker runtime, or run Electron on the host.",
    );
  }
  const probe = probeNativeRuntime();
  if (!probe.bin) {
    throw new Error(probe.error ?? "llama-server binary not found");
  }
  return probe.bin;
}

export async function ensureServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    if (!metalEnabled()) {
      throw new Error(
        "Metal backend requires host agent — start mac/scripts/run-host-agent.sh and set REVOLVER_LLAMA_SOCKET",
      );
    }
    await hostAgentCall("ensure", { serverId: def.id, hostPort: def.hostPort }, HOST_AGENT_FAST_MS);
    return;
  }
  if (isNativeRuntime(def)) {
    const engine = getEngine(def.engine);
    if (!engine.capabilities.supportsNative) {
      throw new Error(`${engine.label} requires Docker — native runtime is llama.cpp only`);
    }
    assertNativeAllowed();
    getNativeSupervisor().ensure(def.id, def.hostPort);
    return;
  }
  await ensureServerContainer(def, getEngine(def.engine).containerSpec(def));
}

export async function restartServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    await hostAgentCall("restart", { serverId: def.id, hostPort: def.hostPort }, HOST_AGENT_SLOW_MS);
    return;
  }
  if (isNativeRuntime(def)) {
    assertNativeAllowed();
    await getNativeSupervisor().restart(def.id, def.hostPort);
    return;
  }
  await restartServerContainer(def.id);
}

export async function stopServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    await hostAgentCall("stop", { serverId: def.id }, HOST_AGENT_FAST_MS);
    return;
  }
  if (isNativeRuntime(def)) {
    await getNativeSupervisor().stop(def.id);
    return;
  }
  await stopServerContainer(def.id);
}

export async function inspectServerStatus(def: ServerDefinition): Promise<string> {
  if (isMetalBackend(def)) {
    const inspect = await hostAgentCall<ServerInspect>(
      "inspect",
      { serverId: def.id },
      HOST_AGENT_FAST_MS,
    );
    return inspect.status === "running" ? "running" : "exited";
  }
  if (isNativeRuntime(def)) {
    const inspect = getNativeSupervisor().inspect(def.id);
    return inspect.status === "running" ? "running" : "exited";
  }
  return inspectContainerStatus(def.id);
}

export async function inspectServerPid(def: ServerDefinition): Promise<number | null> {
  if (isMetalBackend(def)) {
    try {
      const inspect = await hostAgentCall<ServerInspect>(
        "inspect",
        { serverId: def.id },
        HOST_AGENT_FAST_MS,
      );
      return inspect.pid;
    } catch {
      return null;
    }
  }
  if (isNativeRuntime(def)) {
    return getNativeSupervisor().inspect(def.id).pid;
  }
  return null;
}

export async function fetchServerLogs(
  def: ServerDefinition,
  opts?: { tail?: number; since?: string | null },
): Promise<string[]> {
  if (isMetalBackend(def)) {
    const lines = await hostAgentCall<string[]>(
      "logs",
      {
        serverId: def.id,
        tail: opts?.tail ?? 200,
      },
      HOST_AGENT_FAST_MS,
    );
    return lines;
  }
  if (isNativeRuntime(def)) {
    return getNativeSupervisor().logs(def.id, opts?.tail ?? 200);
  }
  return fetchContainerLogs(def.id, opts);
}

export async function getServerStartedAt(def: ServerDefinition): Promise<string | null> {
  if (isMetalBackend(def)) {
    const inspect = await hostAgentCall<ServerInspect>(
      "inspect",
      { serverId: def.id },
      HOST_AGENT_FAST_MS,
    );
    return inspect.startedAt;
  }
  if (isNativeRuntime(def)) {
    return getNativeSupervisor().inspect(def.id).startedAt;
  }
  return getContainerStartedAt(def.id);
}

export async function removeServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    await hostAgentCall("stop", { serverId: def.id }, HOST_AGENT_FAST_MS).catch(() => {});
    return;
  }
  if (isNativeRuntime(def)) {
    await getNativeSupervisor().stop(def.id).catch(() => {});
    return;
  }
  await removeServerContainer(def.id);
}
