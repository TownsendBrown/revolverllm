import { contextBridge, ipcRenderer } from "electron";
import type { RevolverApi } from "../shared/types";

const api: RevolverApi = {
  getPaths: () => ipcRenderer.invoke("revolver:getPaths"),
  getConfig: () => ipcRenderer.invoke("revolver:getConfig"),
  setConfig: (patch) => ipcRenderer.invoke("revolver:setConfig", patch),
  getGpu: () => ipcRenderer.invoke("revolver:getGpu"),
  getPlatform: () => ipcRenderer.invoke("revolver:getPlatform"),
  getMonitor: () => ipcRenderer.invoke("revolver:getMonitor"),
  getModels: () => ipcRenderer.invoke("revolver:getModels"),
  getEngines: () => ipcRenderer.invoke("revolver:getEngines"),
  estimateVram: (opts) => ipcRenderer.invoke("revolver:estimateVram", opts),
  loadModel: (opts) => ipcRenderer.invoke("revolver:loadModel", opts),
  loadModelFromPath: (opts) => ipcRenderer.invoke("revolver:loadModelFromPath", opts),
  pickModelFile: () => ipcRenderer.invoke("revolver:pickModelFile"),
  unloadModel: () => ipcRenderer.invoke("revolver:unloadModel"),
  listServers: () => ipcRenderer.invoke("revolver:listServers"),
  getServerStatus: (serverId) => ipcRenderer.invoke("revolver:getServerStatus", serverId),
  createServer: (opts) => ipcRenderer.invoke("revolver:createServer", opts),
  startServer: (id, force) => ipcRenderer.invoke("revolver:startServer", id, force),
  stopServer: (id) => ipcRenderer.invoke("revolver:stopServer", id),
  deleteServer: (id) => ipcRenderer.invoke("revolver:deleteServer", id),
  getServerConfig: () => ipcRenderer.invoke("revolver:getServerConfig"),
  setServerConfig: (patch) => ipcRenderer.invoke("revolver:setServerConfig", patch),
  getRuntimeConfig: () => ipcRenderer.invoke("revolver:getRuntimeConfig"),
  setRuntimeConfig: (patch) => ipcRenderer.invoke("revolver:setRuntimeConfig", patch),
  clearServerLogs: (serverId) => ipcRenderer.invoke("revolver:clearServerLogs", serverId),
  chat: (messages, serverId) => ipcRenderer.invoke("revolver:chat", messages, serverId),
  listConversations: () => ipcRenderer.invoke("revolver:listConversations"),
  createConversation: (meta) => ipcRenderer.invoke("revolver:createConversation", meta),
  getConversation: (id) => ipcRenderer.invoke("revolver:getConversation", id),
  renameConversation: (id, title) => ipcRenderer.invoke("revolver:renameConversation", id, title),
  updateConversationMeta: (id, meta) => ipcRenderer.invoke("revolver:updateConversationMeta", id, meta),
  deleteConversation: (id) => ipcRenderer.invoke("revolver:deleteConversation", id),
  sendMessage: (id, content, opts) => {
    if (!opts?.onDelta) {
      return ipcRenderer.invoke("revolver:sendMessage", {
        id,
        content,
        serverId: opts?.serverId,
        enableThinking: opts?.enableThinking,
      });
    }
    const requestId = crypto.randomUUID();
    const onDeltaEvent = (
      _e: unknown,
      data: { requestId: string; delta: { content?: string; reasoning?: string } },
    ) => {
      if (data.requestId !== requestId) return;
      opts.onDelta!(data.delta);
    };
    ipcRenderer.on("revolver:streamDelta", onDeltaEvent);
    return ipcRenderer
      .invoke("revolver:sendMessage", {
        id,
        content,
        serverId: opts.serverId,
        enableThinking: opts.enableThinking,
        stream: true,
        requestId,
      })
      .finally(() => {
        ipcRenderer.removeListener("revolver:streamDelta", onDeltaEvent);
      });
  },
  openPath: (path) => ipcRenderer.invoke("revolver:openPath", path),
  focusWindow: () => ipcRenderer.invoke("revolver:focusWindow"),
  listBenchmarkDefinitions: () => ipcRenderer.invoke("revolver:listBenchmarkDefinitions"),
  listBenchmarkRuns: () => ipcRenderer.invoke("revolver:listBenchmarkRuns"),
  getBenchmarkRun: (id) => ipcRenderer.invoke("revolver:getBenchmarkRun", id),
  startBenchmarkRun: (req) => ipcRenderer.invoke("revolver:startBenchmarkRun", req),
  cancelBenchmarkRun: (id) => ipcRenderer.invoke("revolver:cancelBenchmarkRun", id),
  deleteBenchmarkRun: (id) => ipcRenderer.invoke("revolver:deleteBenchmarkRun", id),
  setBenchmarkHumanScore: (runId, testId, humanScore, humanMaxScore, humanNotes) =>
    ipcRenderer.invoke("revolver:setBenchmarkHumanScore", {
      runId,
      testId,
      humanScore,
      humanMaxScore,
      humanNotes,
    }),
  readBenchmarkArtifact: (runId, testId, filename) =>
    ipcRenderer.invoke("revolver:readBenchmarkArtifact", { runId, testId, filename }),
};

contextBridge.exposeInMainWorld("revolver", api);
