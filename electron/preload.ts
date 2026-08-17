import { contextBridge, ipcRenderer } from "electron";
import { bindAbortSignal } from "./lib/abortBridge";
import type { RevolverApi } from "../shared/types";

/** In-flight streamed send — AbortSignal cannot cross contextBridge. */
let activeStreamRequestId: string | null = null;

const api: RevolverApi = {
  getPaths: () => ipcRenderer.invoke("revolver:getPaths"),
  getConfig: () => ipcRenderer.invoke("revolver:getConfig"),
  setConfig: (patch) => ipcRenderer.invoke("revolver:setConfig", patch),
  getSettings: () => ipcRenderer.invoke("revolver:getSettings"),
  setSettings: (patch) => ipcRenderer.invoke("revolver:setSettings", patch),
  setHfToken: (token) => ipcRenderer.invoke("revolver:setHfToken", token),
  clearHfToken: () => ipcRenderer.invoke("revolver:clearHfToken"),
  searchHubModels: (query, filter, sort) =>
    ipcRenderer.invoke("revolver:searchHubModels", query, filter, sort),
  listHubRepoFiles: (repoId, revision) =>
    ipcRenderer.invoke("revolver:listHubRepoFiles", repoId, revision),
  startModelDownload: (req) => ipcRenderer.invoke("revolver:startModelDownload", req),
  listDownloads: () => ipcRenderer.invoke("revolver:listDownloads"),
  getDownload: (jobId) => ipcRenderer.invoke("revolver:getDownload", jobId),
  cancelDownload: (jobId) => ipcRenderer.invoke("revolver:cancelDownload", jobId),
  getRuntimesStatus: () => ipcRenderer.invoke("revolver:getRuntimesStatus"),
  installRuntime: (runtimeId) => ipcRenderer.invoke("revolver:installRuntime", runtimeId),
  listRuntimeInstalls: () => ipcRenderer.invoke("revolver:listRuntimeInstalls"),
  getRuntimeInstall: (jobId) => ipcRenderer.invoke("revolver:getRuntimeInstall", jobId),
  cancelRuntimeInstall: (jobId) => ipcRenderer.invoke("revolver:cancelRuntimeInstall", jobId),
  getGpu: () => ipcRenderer.invoke("revolver:getGpu"),
  getPlatform: () => ipcRenderer.invoke("revolver:getPlatform"),
  getMonitor: () => ipcRenderer.invoke("revolver:getMonitor"),
  getModels: () => ipcRenderer.invoke("revolver:getModels"),
  deleteLocalModel: (id) => ipcRenderer.invoke("revolver:deleteLocalModel", id),
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
    activeStreamRequestId = requestId;
    const onAbort = () => {
      ipcRenderer.send("revolver:cancelStream", requestId);
    };
    const unbindAbort = bindAbortSignal(opts.signal, onAbort);
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
        unbindAbort();
        if (activeStreamRequestId === requestId) activeStreamRequestId = null;
      });
  },
  cancelChatStream: async () => {
    if (!activeStreamRequestId) return;
    ipcRenderer.send("revolver:cancelStream", activeStreamRequestId);
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
