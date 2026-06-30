import { useCallback, useEffect, useState } from "react";
import ConfigPanel from "./components/ConfigPanel";
import ChatPanel from "./components/ChatPanel";
import Logo from "./components/Logo";
import MonitorPanel from "./components/MonitorPanel";
import ServerPanel from "./components/ServerPanel";
import {
  api,
  type CatalogModel,
  type GpuInfo,
  type RevolverConfig,
  type ServerStatus,
} from "./revolver";

type Tab = "chat" | "config" | "monitor" | "server";

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const paths = await api.getPaths();
      setConfig(paths.config);
      setConfigDraft(paths.config);
      const [m, g, s] = await Promise.all([
        api.getModels(),
        api.getGpu(),
        api.getServerStatus(),
      ]);
      setModels(m.models);
      setGpu(g);
      setServerStatus(s);
      setConfigVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (tab !== "server" && !serverStatus?.activeCount && busy !== "load" && busy !== "create") return;
    const ms = busy === "load" || busy === "create" ? 500 : 1500;
    const t = setInterval(() => {
      api.getServerStatus().then(setServerStatus);
    }, ms);
    return () => clearInterval(t);
  }, [tab, serverStatus?.activeCount, busy]);

  const nav: { id: Tab; label: string; icon: string }[] = [
    { id: "chat", label: "Chat", icon: "💬" },
    { id: "server", label: "Server", icon: "🌐" },
    { id: "config", label: "Config", icon: "⚙️" },
    { id: "monitor", label: "Monitor", icon: "📊" },
  ];

  const runAction = (fn: () => Promise<unknown> | void) => {
    setMenuOpen(false);
    Promise.resolve(fn()).catch((e) => setError(String(e)));
  };

  const menuItems: { label: string; disabled?: boolean; action: () => Promise<unknown> | void }[] = [
    {
      label: "Stop all servers",
      disabled: !serverStatus?.activeCount,
      action: () => api.unloadModel().then(refresh),
    },
    { label: "Clear server logs", action: () => api.clearServerLogs().then(refresh) },
    {
      label: "Open models folder",
      disabled: !config,
      action: () => (config ? api.openPath(config.modelsDir) : undefined),
    },
    {
      label: "Open data folder",
      disabled: !config,
      action: () => (config ? api.openPath(config.localRoot) : undefined),
    },
    { label: "Refresh", action: refresh },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <Logo />
        {nav.map((n) => (
          <button
            key={n.id}
            className={`nav-btn ${tab === n.id ? "active" : ""}`}
            onClick={() => setTab(n.id)}
            title={n.label}
          >
            <span className="nav-icon">{n.icon}</span>
            <span className="nav-label">{n.label}</span>
          </button>
        ))}
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

        {tab === "config" && configDraft && (
          <ConfigPanel
            config={config}
            configDraft={configDraft}
            setConfigDraft={setConfigDraft}
            gpu={gpu}
            onSavePaths={() =>
              api.setConfig(configDraft).then((c) => {
                setConfig(c);
                refresh();
              })
            }
            onRefresh={refresh}
          />
        )}

        {tab === "chat" && (
          <ChatPanel serverStatus={serverStatus} onError={setError} />
        )}

        {tab === "monitor" && <MonitorPanel />}

        {tab === "server" && (
          <ServerPanel
            models={models}
            gpu={gpu}
            serverStatus={serverStatus}
            configVersion={configVersion}
            busy={busy}
            setBusy={setBusy}
            onRefresh={refresh}
            onError={setError}
          />
        )}
      </main>
    </div>
  );
}
