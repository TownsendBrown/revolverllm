import { existsSync } from "fs";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { applyElectronDockerEnv } from "./lib/dockerEnv";
import { initElectronConfig, loadConfig } from "./lib/config";
import { openPathElectron } from "./lib/openPath";
import { handlers } from "../server/handlers";
import { setNativeOpenPathOpener } from "../server/openPathDispatch";

applyElectronDockerEnv();
setNativeOpenPathOpener(openPathElectron);

const __dirname = dirname(fileURLToPath(import.meta.url));

function preloadPath(): string {
  const js = join(__dirname, "preload.js");
  if (existsSync(js)) return js;
  const mjs = join(__dirname, "preload.mjs");
  if (existsSync(mjs)) return mjs;
  return js;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Revolver",
    backgroundColor: "#d4d0c8",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(__dirname, "../dist/index.html"));
  }
}

function bindHandler(channel: string, fn: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (_e, arg) => fn(arg));
}

app.whenReady().then(async () => {
  initElectronConfig();

  bindHandler("revolver:getPaths", () => handlers.getPaths());
  bindHandler("revolver:getConfig", () => handlers.getConfig());
  bindHandler("revolver:setConfig", handlers.setConfig);
  bindHandler("revolver:getGpu", () => handlers.getGpu());
  bindHandler("revolver:getPlatform", () => handlers.getPlatform());
  bindHandler("revolver:getMonitor", () => handlers.getMonitor());
  bindHandler("revolver:getModels", () => handlers.getModels());
  bindHandler("revolver:getServerConfig", () => handlers.getServerConfig());
  bindHandler("revolver:setServerConfig", handlers.setServerConfig);
  bindHandler("revolver:getRuntimeConfig", () => handlers.getRuntimeConfig());
  bindHandler("revolver:setRuntimeConfig", handlers.setRuntimeConfig);
  ipcMain.handle("revolver:getServerStatus", (_e, id?: string) => handlers.getServerStatus(id));
  bindHandler("revolver:listServers", () => handlers.listServers());
  bindHandler("revolver:createServer", handlers.createServer);
  ipcMain.handle("revolver:startServer", (_e, id: string, force?: boolean) =>
    handlers.startServer(id, force),
  );
  ipcMain.handle("revolver:stopServer", (_e, id: string) => handlers.stopServer(id));
  ipcMain.handle("revolver:deleteServer", (_e, id: string) => handlers.deleteServer(id));
  ipcMain.handle("revolver:clearServerLogs", (_e, id?: string) => handlers.clearServerLogs(id));
  bindHandler("revolver:estimateVram", handlers.estimateVram);
  bindHandler("revolver:loadModel", handlers.loadModel);
  bindHandler("revolver:loadModelFromPath", handlers.loadModelFromPath);
  bindHandler("revolver:unloadModel", () => handlers.unloadModel());
  ipcMain.handle("revolver:chat", (_e, messages: unknown, serverId?: string) =>
    handlers.chat(messages as Array<{ role: string; content: string }>, serverId),
  );
  bindHandler("revolver:listConversations", () => handlers.listConversations());
  bindHandler("revolver:createConversation", handlers.createConversation);
  ipcMain.handle("revolver:getConversation", (_e, id: string) => handlers.getConversation(id));
  ipcMain.handle("revolver:renameConversation", (_e, id: string, title: string) =>
    handlers.renameConversation(id, title),
  );
  ipcMain.handle("revolver:updateConversationMeta", (_e, id: string, meta: unknown) =>
    handlers.updateConversationMeta(id, meta as Parameters<typeof handlers.updateConversationMeta>[1]),
  );
  ipcMain.handle("revolver:deleteConversation", (_e, id: string) => handlers.deleteConversation(id));
  ipcMain.handle(
    "revolver:sendMessage",
    (
      event,
      arg: {
        id: string;
        content: string;
        serverId?: string | null;
        stream?: boolean;
        requestId?: string;
      },
    ) => {
      if (arg.stream && arg.requestId) {
        return handlers.sendMessage(arg.id, arg.content, arg.serverId, (delta) => {
          event.sender.send("revolver:streamDelta", { requestId: arg.requestId, delta });
        });
      }
      return handlers.sendMessage(arg.id, arg.content, arg.serverId);
    },
  );

  ipcMain.handle("revolver:pickModelFile", async () => {
    const cfg = loadConfig();
    const result = await dialog.showOpenDialog({
      title: "Open GGUF model",
      defaultPath: cfg.modelsDir,
      filters: [{ name: "GGUF", extensions: ["gguf"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("revolver:openPath", (_e, p: string) => handlers.openPath(p));

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await handlers.unloadModel();
  if (process.platform !== "darwin") app.quit();
});
