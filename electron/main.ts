import { existsSync, statSync } from "fs";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { applyElectronDockerEnv } from "./lib/dockerEnv";
import { applyPackagedRuntimeDefault } from "./lib/nativeLaunch";
import { initElectronConfig, loadConfig } from "./lib/config";
import { closeChatDb } from "./lib/chatDb";
import { toIpcError } from "./lib/ipcErrors";
import { chromeSandboxNeedsNoSandbox } from "./lib/linuxSandbox";
import { openPathElectron } from "./lib/openPath";
import { handlers } from "../server/handlers";
import { setNativeOpenPathOpener } from "../server/openPathDispatch";
import { serverManager } from "../server/serverManager";
import { startOpenAiGateway, stopOpenAiGateway } from "../server/openaiGateway";

function applyLinuxSandboxWorkaround(): void {
  if (process.platform !== "linux") return;
  const helper = join(dirname(process.execPath), "chrome-sandbox");
  try {
    const st = statSync(helper);
    if (!chromeSandboxNeedsNoSandbox(st.mode, st.uid)) return;
  } catch {
    /* missing helper */
  }
  app.commandLine.appendSwitch("no-sandbox");
}

applyLinuxSandboxWorkaround();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  applyElectronDockerEnv();
  applyPackagedRuntimeDefault();
  setNativeOpenPathOpener(openPathElectron);

  process.on("uncaughtException", (e) => {
    console.error("uncaughtException", e);
    if (app.isReady()) {
      dialog.showErrorBox("Revolver", e instanceof Error ? e.message : String(e));
    }
  });
  process.on("unhandledRejection", (e) => {
    console.error("unhandledRejection", e);
  });

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(onReady);
  app.on("before-quit", onBeforeQuit);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function preloadPath(): string {
  const js = join(__dirname, "preload.js");
  if (existsSync(js)) return js;
  const mjs = join(__dirname, "preload.mjs");
  if (existsSync(mjs)) return mjs;
  return js;
}

/** Packaged asar + repo: square icon derived from img/logo.png. */
function appIconPath(): string {
  const candidates = [
    join(__dirname, "../build/icon.png"),
    join(__dirname, "../img/logo.png"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/** Restore keyboard focus without hiding the window (no blur/show flash). */
function restoreRendererFocus(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isFocused()) win.focus();
  win.webContents.focus();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "Revolver",
    icon: appIconPath(),
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

function withIpcError<Args extends unknown[]>(
  fn: (...args: Args) => unknown,
): (...args: Args) => Promise<unknown> {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw toIpcError(e);
    }
  };
}

function bindHandler<T>(channel: string, fn: (arg: T) => unknown) {
  ipcMain.handle(channel, withIpcError((_e, arg) => fn(arg as T)));
}

async function onReady(): Promise<void> {
  if (process.platform === "darwin" && app.dock) {
    const icon = appIconPath();
    if (existsSync(icon)) app.dock.setIcon(icon);
  }

  try {
    initElectronConfig();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message);
    dialog.showErrorBox("Revolver", message);
  }

  try {
    await serverManager.reconcile();
  } catch (e) {
    console.warn(`reconcile on boot failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await startOpenAiGateway();
  } catch (e) {
    console.warn(`OpenAI gateway failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  bindHandler("revolver:getPaths", () => handlers.getPaths());
  bindHandler("revolver:getConfig", () => handlers.getConfig());
  bindHandler("revolver:setConfig", handlers.setConfig);
  bindHandler("revolver:getGpu", () => handlers.getGpu());
  bindHandler("revolver:getPlatform", () => handlers.getPlatform());
  bindHandler("revolver:getMonitor", () => handlers.getMonitor());
  bindHandler("revolver:getModels", () => handlers.getModels());
  bindHandler("revolver:getEngines", () => handlers.getEngines());
  bindHandler("revolver:getServerConfig", () => handlers.getServerConfig());
  bindHandler("revolver:setServerConfig", handlers.setServerConfig);
  bindHandler("revolver:getRuntimeConfig", () => handlers.getRuntimeConfig());
  bindHandler("revolver:setRuntimeConfig", handlers.setRuntimeConfig);
  ipcMain.handle(
    "revolver:getServerStatus",
    withIpcError((_e, id?: string) => handlers.getServerStatus(id)),
  );
  bindHandler("revolver:listServers", () => handlers.listServers());
  bindHandler("revolver:createServer", handlers.createServer);
  ipcMain.handle(
    "revolver:startServer",
    withIpcError((_e, id: string, force?: boolean) => handlers.startServer(id, force)),
  );
  ipcMain.handle(
    "revolver:stopServer",
    withIpcError((_e, id: string) => handlers.stopServer(id)),
  );
  ipcMain.handle(
    "revolver:deleteServer",
    withIpcError((_e, id: string) => handlers.deleteServer(id)),
  );
  ipcMain.handle(
    "revolver:clearServerLogs",
    withIpcError((_e, id?: string) => handlers.clearServerLogs(id)),
  );
  bindHandler("revolver:estimateVram", handlers.estimateVram);
  bindHandler("revolver:loadModel", handlers.loadModel);
  bindHandler("revolver:loadModelFromPath", handlers.loadModelFromPath);
  bindHandler("revolver:unloadModel", () => handlers.unloadModel());
  ipcMain.handle(
    "revolver:chat",
    withIpcError((_e, messages: unknown, serverId?: string) =>
      handlers.chat(messages as Array<{ role: string; content: string }>, serverId),
    ),
  );
  bindHandler("revolver:listConversations", () => handlers.listConversations());
  bindHandler("revolver:createConversation", handlers.createConversation);
  ipcMain.handle(
    "revolver:getConversation",
    withIpcError((_e, id: string) => handlers.getConversation(id)),
  );
  ipcMain.handle(
    "revolver:renameConversation",
    withIpcError((_e, id: string, title: string) => handlers.renameConversation(id, title)),
  );
  ipcMain.handle(
    "revolver:updateConversationMeta",
    withIpcError((_e, id: string, meta: unknown) =>
      handlers.updateConversationMeta(
        id,
        meta as Parameters<typeof handlers.updateConversationMeta>[1],
      ),
    ),
  );
  ipcMain.handle(
    "revolver:deleteConversation",
    withIpcError((_e, id: string) => handlers.deleteConversation(id)),
  );
  ipcMain.handle(
    "revolver:sendMessage",
    withIpcError(
      (
        event,
        arg: {
          id: string;
          content: string;
          serverId?: string | null;
          stream?: boolean;
          requestId?: string;
          enableThinking?: boolean;
        },
      ) => {
        if (arg.stream && arg.requestId) {
          return handlers.sendMessage(
            arg.id,
            arg.content,
            arg.serverId,
            (delta) => {
              event.sender.send("revolver:streamDelta", { requestId: arg.requestId, delta });
            },
            arg.enableThinking,
          );
        }
        return handlers.sendMessage(arg.id, arg.content, arg.serverId, undefined, arg.enableThinking);
      },
    ),
  );

  ipcMain.handle(
    "revolver:pickModelFile",
    withIpcError(async (e: Electron.IpcMainInvokeEvent) => {
      const cfg = loadConfig();
      const result = await dialog.showOpenDialog({
        title: "Open GGUF model",
        defaultPath: cfg.modelsDir,
        filters: [{ name: "GGUF", extensions: ["gguf"] }],
        properties: ["openFile"],
      });
      restoreRendererFocus(BrowserWindow.fromWebContents(e.sender));
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    }),
  );

  ipcMain.handle("revolver:openPath", withIpcError((_e, p: string) => handlers.openPath(p)));
  ipcMain.handle("revolver:focusWindow", (e) => {
    restoreRendererFocus(BrowserWindow.fromWebContents(e.sender));
  });

  bindHandler("revolver:listBenchmarkDefinitions", () => handlers.listBenchmarkDefinitions());
  bindHandler("revolver:listBenchmarkRuns", () => handlers.listBenchmarkRuns());
  ipcMain.handle(
    "revolver:getBenchmarkRun",
    withIpcError((_e, id: string) => handlers.getBenchmarkRun(id)),
  );
  bindHandler("revolver:startBenchmarkRun", handlers.startBenchmarkRun);
  ipcMain.handle(
    "revolver:cancelBenchmarkRun",
    withIpcError((_e, id: string) => handlers.cancelBenchmarkRun(id)),
  );
  ipcMain.handle(
    "revolver:deleteBenchmarkRun",
    withIpcError((_e, id: string) => handlers.deleteBenchmarkRun(id)),
  );
  ipcMain.handle(
    "revolver:setBenchmarkHumanScore",
    withIpcError(
      (
        _e,
        arg: {
          runId: string;
          testId: import("../shared/benchmarks/types").BenchmarkCategory;
          humanScore: number;
          humanMaxScore?: number;
          humanNotes?: string;
        },
      ) =>
        handlers.setBenchmarkHumanScore(
          arg.runId,
          arg.testId,
          arg.humanScore,
          arg.humanMaxScore,
          arg.humanNotes,
        ),
    ),
  );

  ipcMain.handle(
    "revolver:readBenchmarkArtifact",
    withIpcError((_e, arg: { runId: string; testId: string; filename: string }) =>
      handlers.readBenchmarkArtifact(arg.runId, arg.testId, arg.filename),
    ),
  );

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

let quitting = false;

function onBeforeQuit(e: Electron.Event): void {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void (async () => {
    try {
      await stopOpenAiGateway();
    } catch (err) {
      console.warn(`gateway shutdown: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await serverManager.unloadAll();
    } catch (err) {
      console.warn(`unload on quit: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      closeChatDb();
    } catch (err) {
      console.warn(`close chat db: ${err instanceof Error ? err.message : String(err)}`);
    }
    app.exit(0);
  })();
}
