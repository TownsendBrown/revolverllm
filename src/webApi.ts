import type { RevolverApi, SendMessageResult } from "../shared/types";

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? (await res.text()) ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? (await res.text()) ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

async function del(path: string): Promise<void> {
  const res = await fetch(path, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? (await res.text()) ?? res.statusText);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? ((await res.text()) || res.statusText));
  }
  return res.json() as Promise<T>;
}

function parseSsePayload(part: string): {
  delta?: string;
  done?: boolean;
  result?: SendMessageResult;
  error?: string;
} | null {
  const line = part.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(5).trim()) as {
      delta?: string;
      done?: boolean;
      result?: SendMessageResult;
      error?: string;
    };
  } catch {
    return null;
  }
}

function isNetworkError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return false;
  if (e instanceof TypeError) return true;
  const msg = String(e);
  return (
    msg.includes("NetworkError") ||
    msg.includes("Failed to fetch") ||
    msg.includes("Load failed") ||
    msg.includes("network error")
  );
}

async function streamSendMessage(
  base: string,
  id: string,
  content: string,
  serverId: string | null | undefined,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
): Promise<SendMessageResult> {
  let res: Response;
  try {
    res = await fetch(`${base}/conversations/${id}/messages/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ content, serverId }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    if (isNetworkError(e)) {
      throw new Error("Connection lost while streaming. Reload the chat — the reply may still finish.");
    }
    throw e;
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? (await res.text()) ?? res.statusText);
  }
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumePart = (part: string): SendMessageResult | null => {
    if (!part.trim() || part.startsWith(":")) return null;
    const payload = parseSsePayload(part);
    if (!payload) return null;
    if (payload.error) throw new Error(payload.error);
    if (payload.delta) onDelta(payload.delta);
    if (payload.done && payload.result) return payload.result;
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const result = consumePart(part);
        if (result) return result;
      }
    }
    buffer += decoder.decode();
    for (const part of buffer.split("\n\n")) {
      const result = consumePart(part);
      if (result) return result;
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    if (isNetworkError(e)) {
      throw new Error("Connection lost while streaming. Reload the chat — the reply may still finish.");
    }
    throw e;
  }
  throw new Error("Stream ended without result");
}

export function createWebApi(base = "/api"): RevolverApi {
  const p = (suffix: string) => `${base}${suffix}`;
  return {
    getPaths: () => get(p("/paths")),
    getConfig: () => get(p("/config")),
    setConfig: (patch) => post(p("/config"), patch),
    getGpu: () => get(p("/gpu")),
    getMonitor: () => get(p("/monitor")),
    getModels: () => get(p("/models")),
    estimateVram: (opts) => post(p("/vram/estimate"), opts),
    loadModel: (opts) => post(p("/models/load"), opts),
    loadModelFromPath: (opts) => post(p("/models/load-path"), opts),
    pickModelFile: async () => null,
    unloadModel: () => post(p("/models/unload")),
    listServers: () => get(p("/servers")),
    getServerStatus: (serverId) =>
      get(p(serverId ? `/server/status?id=${encodeURIComponent(serverId)}` : "/server/status")),
    createServer: (opts) => post(p("/servers"), opts),
    startServer: (id, force) => post(p(`/servers/${id}/start`), { force }),
    stopServer: (id) => post(p(`/servers/${id}/stop`)),
    deleteServer: (id) => del(p(`/servers/${id}`)),
    getServerConfig: () => get(p("/server/config")),
    setServerConfig: (patch) => post(p("/server/config"), patch),
    getRuntimeConfig: () => get(p("/runtime/config")),
    setRuntimeConfig: (patch) => post(p("/runtime/config"), patch),
    clearServerLogs: (serverId) => post(p("/server/logs/clear"), { serverId }),
    chat: (messages, serverId) => post(p("/chat"), { messages, serverId }),
    listConversations: () => get(p("/conversations")),
    createConversation: (meta) => post(p("/conversations"), meta ?? {}),
    getConversation: (id) => get(p(`/conversations/${id}`)),
    renameConversation: (id, title) => patch(p(`/conversations/${id}`), { title }),
    updateConversationMeta: (id, meta) => patch(p(`/conversations/${id}`), meta),
    deleteConversation: (id) => del(p(`/conversations/${id}`)),
    sendMessage: (id, content, opts) => {
      if (opts?.onDelta) {
        return streamSendMessage(base, id, content, opts.serverId, opts.onDelta, opts.signal);
      }
      return post(p(`/conversations/${id}/messages`), { content, serverId: opts?.serverId });
    },
    openPath: (path) => post(p("/open-path"), { path }),
  };
}
