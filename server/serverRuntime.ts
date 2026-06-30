import type { ServerDefinition } from "../shared/types";
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

const HOST_AGENT_FAST_MS = 10_000;
const HOST_AGENT_SLOW_MS = 120_000;

interface ServerInspect {
  serverId: string;
  hostPort: number;
  status: "idle" | "starting" | "running" | "stopped" | "crashed";
  pid: number | null;
  startedAt: string | null;
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
  await ensureServerContainer(def);
}

export async function restartServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    await hostAgentCall("restart", { serverId: def.id, hostPort: def.hostPort }, HOST_AGENT_SLOW_MS);
    return;
  }
  await restartServerContainer(def.id);
}

export async function stopServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    await hostAgentCall("stop", { serverId: def.id }, HOST_AGENT_FAST_MS);
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
  return inspectContainerStatus(def.id);
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
  return getContainerStartedAt(def.id);
}

export async function removeServerRuntime(def: ServerDefinition): Promise<void> {
  if (isMetalBackend(def)) {
    await hostAgentCall("stop", { serverId: def.id }, HOST_AGENT_FAST_MS).catch(() => {});
    return;
  }
  await removeServerContainer(def.id);
}
