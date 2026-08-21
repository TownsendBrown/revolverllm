import { useCallback, useEffect, useRef, useState } from "react";
import ConfigPanel from "./components/ConfigPanel";
import ModelsPanel from "./components/ModelsPanel";
import ChatPanel from "./components/ChatPanel";
import Logo from "./components/Logo";
import MonitorPanel from "./components/MonitorPanel";
import ServerPanel from "./components/ServerPanel";
import RuntimeSetupPanel from "./components/RuntimeSetupPanel";
import configIcon from "../icons/config-icon.v6.svg";
import chatIcon from "../icons/chat-icon.v1.svg";
import modelsIcon from "../icons/models-icon.v1.svg";
import monitorIcon from "../icons/monitor-icon.v2.svg";
import serverIcon from "../icons/servers-icon.v2.svg";
import {
  api,
  type CatalogModel,
  type GpuInfo,
  type PlatformCapabilities,
  type RevolverConfig,
  type ServerStatus,
} from "./revolver";

type Tab = "models" | "chat" | "config" | "monitor" | "server";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [config, setConfig] = useState<RevolverConfig | null>(null);
  const [configDraft, setConfigDraft] = useState<RevolverConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [gpu, setGpu] = useState<GpuInfo | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [configVersion, setConfigVersion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformCapabilities | null>(null);
  const [runtimeReady, setRuntimeReady] = useState(true);
  const [pendingChatServerId, setPendingChatServerId] = useState<string | null>(null);
  const consumePendingChatServer = useCallback(() => setPendingChatServerId(null), []);
  const statusEpoch = useRef(0);
  const hasLoaded = useRef(false);
  const anyLoadingRef = useRef(false);

  const applyServerStatus = useCallback((s: ServerStatus, epoch: number) => {
    if (epoch === statusEpoch.current) setServerStatus(s);
  }, []);

  const pullServerStatus = useCallback(() => {
    const epoch = ++statusEpoch.current;
    return api.getServerStatus().then((s) => {
      applyServerStatus(s, epoch);
      return s;
    });
  }, [applyServerStatus]);

  const refresh = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    setError("");
    try {
      const paths = await api.getPaths();
      setConfig(paths.config);
      setConfigDraft(paths.config);
      setDataDir(paths.dataDir);
      const epoch = ++statusEpoch.current;
      const [m, g, s, p] = await Promise.all([
        api.getModels(),
        api.getGpu(),
        api.getServerStatus(),
        api.getPlatform(),
      ]);
      setModels(m.models);
      setGpu(g);
      applyServerStatus(s, epoch);
      setPlatform(p);
      // macOS ships no engine binaries: both managed runtimes must be
      // installed from GitHub releases before anything can load a model.
      if (p.os !== "darwin") setRuntimeReady(true);
      else {
        // A probe that cannot answer means no engine can load a model, so fall
        // through to setup instead of leaving the app looking ready.
        try {
          const rt = await api.getRuntimesStatus();
          setRuntimeReady(rt.llamacpp.installed && rt.mlx.installed);
        } catch (e) {
          setRuntimeReady(false);
          setError(String(e));
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      hasLoaded.current = true;
      setLoading(false);
    }
  }, [applyServerStatus]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  const anyLoading = Boolean(
    busy === "load" ||
      busy === "create" ||
      busy === "start" ||
      serverStatus?.loadPhase === "loading" ||
      serverStatus?.servers?.some((s) => s.loadPhase === "loading"),
  );
  anyLoadingRef.current = anyLoading;

  const shouldPoll =
    tab === "server" ||
    tab === "chat" ||
    Boolean(serverStatus?.activeCount) ||
    anyLoading;

  useEffect(() => {
    if (!shouldPoll) return;
    let stopped = false;
    let id: ReturnType<typeof setTimeout>;
    const loop = () => {
      pullServerStatus()
        .catch(() => {})
        .finally(() => {
          if (stopped) return;
          id = setTimeout(loop, anyLoadingRef.current ? 500 : 1500);
        });
    };
    loop();
    return () => {
      stopped = true;
      clearTimeout(id);
    };
  }, [tab, shouldPoll, pullServerStatus]);

  const navIcons: Partial<Record<Tab, string>> = {
    models: modelsIcon,
    chat: chatIcon,
    config: configIcon,
    monitor: monitorIcon,
    server: serverIcon,
  };

  const setupRequired = platform?.os === "darwin" && !runtimeReady;

  const nav: { id: Tab; label: string; icon: string }[] = [
    { id: "chat", label: "Chat", icon: ">" },
    { id: "models", label: "Models", icon: "M" },
    { id: "server", label: "Server", icon: "#" },
    { id: "config", label: "Config", icon: "*" },
    { id: "monitor", label: "Monitor", icon: "=" },
  ];

  const runAction = (fn: () => Promise<unknown> | void) => {
    setMenuOpen(false);
    Promise.resolve(fn()).catch((e) => setError(String(e)));
  };

  const openFolder = (path: string) =>
    api.openPath(path).then((err) => {
      if (err) setError(err);
    });

  const dockerWarn =
    platform &&
    platform.defaultRuntime !== "native" &&
    !platform.docker &&
    (platform.host === "compose" ||
      platform.defaultRuntime === "docker" ||
      (platform.dockerGpu && !platform.native))
      ? `Docker is not available.${
          platform.dockerError ? ` ${platform.dockerError}` : ""
        } Use native runtime or install Docker.`
      : "";

  const canStopAll =
    Boolean(serverStatus?.activeCount) ||
    Boolean(serverStatus?.running) ||
    serverStatus?.loadPhase === "loading" ||
    Boolean(serverStatus?.servers?.some((s) => s.running || s.loadPhase === "loading"));

  const menuItems: { label: string; disabled?: boolean; action: () => Promise<unknown> | void }[] = [
    {
      label: "Stop all servers",
      disabled: !canStopAll,
      action: () => api.unloadModel().then(refresh),
    },
    {
      label: "Open models folder",
      disabled: !config,
      action: () => (config ? openFolder(config.modelsDir) : undefined),
    },
    {
      label: "Open data folder",
      disabled: !dataDir,
      action: () => (dataDir ? openFolder(dataDir) : undefined),
    },
    { label: "Refresh", action: refresh },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <Logo />
        <div className="sidebar-nav">
          {nav.map((n) => {
            const svgIcon = navIcons[n.id];
            return (
              <button
                key={n.id}
                className={`nav-btn ${tab === n.id ? "active" : ""}${svgIcon ? " nav-btn-icon-fill" : ""}`}
                onClick={() => setTab(n.id)}
                disabled={setupRequired}
                title={n.label}
              >
                <span className={`nav-icon${svgIcon ? " nav-icon-svg" : ""}`}>
                  {svgIcon ? (
                    <img src={svgIcon} alt="" className="nav-icon-img" />
                  ) : (
                    n.icon
                  )}
                </span>
                {!svgIcon && <span className="nav-label">{n.label}</span>}
              </button>
            );
          })}
        </div>
        <div className="sidebar-foot">
          {serverStatus?.activeCount ? (
            <>
              <span className="status-dot on" />
              <span className="foot-text">{serverStatus.activeCount} server{serverStatus.activeCount !== 1 ? "s" : ""}</span>
            </>
          ) : (
            <>
              <span className="status-dot" />
              <span className="foot-text">Idle</span>
            </>
          )}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          {tab !== "chat" && <h1>{nav.find((n) => n.id === tab)?.label}</h1>}
          {tab === "chat" && <h1>Chat</h1>}
          <div className="topbar-actions">
            {serverStatus?.activeCount ? (
              <span className="topbar-model" title={serverStatus.loaded?.modelId ?? ""}>
                {serverStatus.activeCount} server{serverStatus.activeCount !== 1 ? "s" : ""}
                {serverStatus.loaded?.modelId && ` · ${serverStatus.loaded.modelId.split("/").pop()}`}
              </span>
            ) : null}
            <button className="ghost" onClick={refresh} disabled={loading}>
              Refresh
            </button>
            <div className="menu-wrap">
              <button
                className="ghost icon-btn"
                aria-label="Actions menu"
                onClick={() => setMenuOpen((v) => !v)}
              >
                ⋯
              </button>
              {menuOpen && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                  <div className="menu-dropdown">
                    {menuItems.map((item) => (
                      <button
                        key={item.label}
                        disabled={item.disabled}
                        onClick={() => runAction(item.action)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {error && <div className="banner error">{error}</div>}
        {dockerWarn && <div className="banner warn">{dockerWarn}</div>}
        {setupRequired && (
          <RuntimeSetupPanel
            onInstalled={() => {
              setRuntimeReady(true);
              refresh().catch(() => {});
            }}
          />
        )}

        {!setupRequired && (
          <>
            {tab === "models" && (
              <ModelsPanel
                models={models}
                platform={platform}
                onRefresh={refresh}
                onError={setError}
              />
            )}

            {tab === "config" && configDraft && (
              <ConfigPanel
                config={config}
                configDraft={configDraft}
                setConfigDraft={setConfigDraft}
                gpu={gpu}
                platform={platform}
                onSavePaths={() =>
                  api.setConfig(configDraft).then((c) => {
                    setConfig(c);
                    setConfigVersion((v) => v + 1);
                    void refresh();
                  })
                }
                onRefresh={() => {
                  setConfigVersion((v) => v + 1);
                  void refresh();
                }}
                onError={setError}
              />
            )}

            <div
              className={tab === "chat" ? "tab-panel" : "tab-panel tab-hidden"}
              aria-hidden={tab !== "chat"}
              inert={tab !== "chat" ? true : undefined}
            >
              <ChatPanel
                serverStatus={serverStatus}
                servers={serverStatus?.servers ?? []}
                pendingServerId={pendingChatServerId}
                visible={tab === "chat"}
                onPendingServerConsumed={consumePendingChatServer}
                onError={setError}
              />
            </div>

            {tab === "monitor" && <MonitorPanel />}

            {tab === "server" && (
              <ServerPanel
                models={models}
                gpu={gpu}
                serverStatus={serverStatus}
                configVersion={configVersion}
                busy={busy}
                setBusy={setBusy}
                onRefresh={pullServerStatus}
                onError={setError}
                onServerReady={setPendingChatServerId}
                onOpenRuntimes={() => {
                  setTab("config");
                  window.setTimeout(() => {
                    document
                      .getElementById("manage-runtimes")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }, 50);
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
