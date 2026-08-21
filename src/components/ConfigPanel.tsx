import { useCallback, useEffect, useState } from "react";
import {
  api,
  type GpuInfo,
  type PlatformCapabilities,
  type RevolverConfig,
  type RevolverSettingsView,
} from "../revolver";
import { vendorLabel } from "../../shared/gpuDevices";
import { linuxRuntimeCards, RuntimeCardGrid, useRuntimeInstalls } from "./RuntimeCards";

type Props = {
  config: RevolverConfig | null;
  configDraft: RevolverConfig;
  setConfigDraft: (c: RevolverConfig) => void;
  gpu: GpuInfo | null;
  platform: PlatformCapabilities | null;
  onSavePaths: () => void;
  onRefresh: () => void;
  onError: (message: string) => void;
};

function gb(n: number) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function LinuxRuntimeManager() {
  const { status, jobs, error, install, activeJob } = useRuntimeInstalls();
  if (!status) {
    return error ? (
      <section className="panel" id="manage-runtimes">
        <h3>Manage runtimes</h3>
        <div className="banner error inline">{error}</div>
      </section>
    ) : null;
  }
  const cards = linuxRuntimeCards(status);
  const rec = cards.find((c) => c.recommended);
  return (
    <section className="panel" id="manage-runtimes">
      <h3>Manage runtimes</h3>
      <p className="muted small">
        Download llama.cpp engines from GitHub releases. Install at least one before starting a
        native server. NVIDIA driver required for CUDA; Mesa + <code>/dev/dri</code> for Vulkan.
      </p>
      {error && <div className="banner error inline">{error}</div>}
      {rec && !rec.installed && (
        <p className="muted small">
          Recommended for this machine: <strong>{rec.label}</strong>{" "}
          <button
            type="button"
            className="primary"
            disabled={Boolean(activeJob)}
            onClick={() => void install(rec.id)}
          >
            Install recommended
          </button>
        </p>
      )}
      <RuntimeCardGrid
        cards={cards}
        jobs={jobs}
        busy={Boolean(activeJob)}
        onInstall={(id) => void install(id)}
      />
    </section>
  );
}

export default function ConfigPanel({
  config,
  configDraft,
  setConfigDraft,
  gpu,
  platform,
  onSavePaths,
  onRefresh,
  onError,
}: Props) {
  const [settings, setSettings] = useState<RevolverSettingsView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<RevolverSettingsView | null>(null);

  const loadSettings = useCallback(() => {
    api.getSettings().then((s) => {
      setSettings(s);
      setSettingsDraft(s);
    });
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const saveSettings = useCallback(async () => {
    if (!settingsDraft) return;
    await api.setSettings({
      paths: settingsDraft.paths,
      inferenceDefaults: settingsDraft.inferenceDefaults,
      gateway: settingsDraft.gateway,
      guardrails: settingsDraft.guardrails,
      downloads: settingsDraft.downloads,
    });
    loadSettings();
    onRefresh();
  }, [settingsDraft, loadSettings, onRefresh]);

  const pathsLocked = platform?.pathSettingsLocked ?? false;
  const hostPaths = platform?.hostPaths;

  return (
    <div className="config-layout">
      <section className="panel">
        <h3>GPUs</h3>
        {!gpu?.available && (
          <p className="muted">{gpu?.error ? `No GPU: ${gpu.error}` : "No GPU detected"}</p>
        )}
        {gpu?.available && (
          <>
            <p className="gpu-summary">
              {gpu.deviceCount} GPU{gpu.deviceCount !== 1 ? "s" : ""} ·{" "}
              <strong>{gb(gpu.totalVramBytes)}</strong> total VRAM ·{" "}
              <strong>{gb(gpu.totalFreeVramBytes)}</strong> free
            </p>
            <div className="gpu-grid">
              {gpu.devices.map((d) => (
                <div key={`${d.vendor}-${d.index}`} className="gpu-card">
                  <strong>
                    GPU {d.index}{" "}
                    <span className={`gpu-vendor ${d.vendor}`}>{vendorLabel(d.vendor)}</span>
                  </strong>
                  <span>{d.name}</span>
                  <span>
                    {d.freeGb} / {d.totalGb} GB free
                  </span>
                  {d.recommendedBackend && (
                    <span className="muted small">Use {d.recommendedBackend.toUpperCase()}</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h3>Model directories</h3>
        {pathsLocked && (
          <p className="banner warn">
            Paths are locked in Docker Compose — set <code>MODELS_DIR</code> in <code>.env</code> and
            recreate the container.
          </p>
        )}
        {hostPaths && pathsLocked && (
          <p className="mono small muted">
            Host models: {hostPaths.modelsDir}
            <br />
            Host hub: {hostPaths.hubModelsDir}
          </p>
        )}
        <div className="config-form">
          <label>
            GGUF / downloads root
            <input
              value={settingsDraft?.paths.modelsDir ?? configDraft.modelsDir}
              disabled={pathsLocked}
              onChange={(e) => {
                const modelsDir = e.target.value;
                setConfigDraft({ ...configDraft, modelsDir });
                setSettingsDraft((s: RevolverSettingsView | null) =>
                  s ? { ...s, paths: { ...s.paths, modelsDir } } : s,
                );
              }}
            />
          </label>
          <label>
            Hub models directory
            <input
              value={settingsDraft?.paths.hubModelsDir ?? configDraft.hubModelsDir}
              disabled={pathsLocked}
              onChange={(e) => {
                const hubModelsDir = e.target.value;
                setConfigDraft({ ...configDraft, hubModelsDir });
                setSettingsDraft((s: RevolverSettingsView | null) =>
                  s ? { ...s, paths: { ...s.paths, hubModelsDir } } : s,
                );
              }}
            />
          </label>
          <label>
            Local metadata root
            <input
              value={settingsDraft?.paths.localRoot ?? configDraft.localRoot}
              disabled={pathsLocked}
              onChange={(e) => {
                const localRoot = e.target.value;
                setConfigDraft({ ...configDraft, localRoot });
                setSettingsDraft((s: RevolverSettingsView | null) =>
                  s ? { ...s, paths: { ...s.paths, localRoot } } : s,
                );
              }}
            />
          </label>
          {!pathsLocked && (
            <button
              className="primary"
              onClick={() => {
                onSavePaths();
                void saveSettings();
              }}
            >
              Save paths
            </button>
          )}
          {config && platform?.canOpenPath && (
            <button
              type="button"
              onClick={() =>
                api.openPath(config.modelsDir).then((err) => {
                  if (err) onError(err);
                })
              }
            >
              Open models folder
            </button>
          )}
        </div>
      </section>

      {settingsDraft && (
        <>
          <section className="panel">
            <h3>Default load settings</h3>
            <div className="config-form">
              <label>
                Default context length
                <input
                  type="number"
                  min={512}
                  max={131072}
                  value={settingsDraft.inferenceDefaults.contextLength}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      inferenceDefaults: {
                        ...settingsDraft.inferenceDefaults,
                        contextLength: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label>
                GPU layers (-1 = all)
                <input
                  type="number"
                  value={settingsDraft.inferenceDefaults.nGpuLayers}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      inferenceDefaults: {
                        ...settingsDraft.inferenceDefaults,
                        nGpuLayers: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              <label>
                KV cache dtype
                <select
                  value={settingsDraft.inferenceDefaults.kvCacheDtype}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      inferenceDefaults: {
                        ...settingsDraft.inferenceDefaults,
                        kvCacheDtype: e.target.value,
                      },
                    })
                  }
                >
                  <option value="f16">f16</option>
                  <option value="f32">f32</option>
                  <option value="q8_0">q8_0</option>
                  <option value="q4_0">q4_0</option>
                </select>
              </label>
            </div>
          </section>

          <section className="panel">
            <h3>VRAM guardrails</h3>
            <div className="config-form">
              <label>
                Mode
                <select
                  value={settingsDraft.guardrails.mode}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      guardrails: { ...settingsDraft.guardrails, mode: e.target.value },
                    })
                  }
                >
                  <option value="off">Off</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {settingsDraft.guardrails.mode === "custom" && (
                <label>
                  Custom threshold (bytes)
                  <input
                    type="number"
                    value={settingsDraft.guardrails.customThresholdBytes}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        guardrails: {
                          ...settingsDraft.guardrails,
                          customThresholdBytes: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={settingsDraft.guardrails.alwaysAllowLoadAnyway === true}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      guardrails: {
                        ...settingsDraft.guardrails,
                        alwaysAllowLoadAnyway: e.target.checked,
                      },
                    })
                  }
                />{" "}
                Always allow “load anyway”
              </label>
            </div>
          </section>

          <section className="panel">
            <h3>OpenAI gateway</h3>
            <p className="muted">
              Unified endpoint for external clients (Cline, Continue, etc.). Uses the same Bearer key as
              the control-plane API when set.
            </p>
            <div className="config-form">
              <label>
                <input
                  type="checkbox"
                  checked={settingsDraft.gateway.gatewayEnabled !== false}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      gateway: { ...settingsDraft.gateway, gatewayEnabled: e.target.checked },
                    })
                  }
                />{" "}
                Gateway enabled
              </label>
              <label>
                Host
                <input
                  value={settingsDraft.gateway.host}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      gateway: { ...settingsDraft.gateway, host: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                Port
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={settingsDraft.gateway.port}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      gateway: { ...settingsDraft.gateway, port: Number(e.target.value) },
                    })
                  }
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={settingsDraft.gateway.gatewayApiKey ?? ""}
                  placeholder={settings?.hasApiKey ? "••••••••" : "Leave empty for open access"}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      gateway: {
                        ...settingsDraft.gateway,
                        gatewayApiKey: e.target.value.trim() || null,
                      },
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settingsDraft.gateway.cors}
                  onChange={(e) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      gateway: { ...settingsDraft.gateway, cors: e.target.checked },
                    })
                  }
                />{" "}
                Enable CORS (browser clients)
              </label>
              <button className="primary" onClick={() => saveSettings().catch((e) => onError(String(e)))}>
                Save settings
              </button>
            </div>
          </section>
        </>
      )}

      {platform && platform.os === "linux" && <LinuxRuntimeManager />}

      {platform && platform.os !== "linux" && (
        <section className="panel">
          <h3>Runtime</h3>
          <p className="muted small">
            Host: {platform.host} · Docker: {platform.docker ? "yes" : "no"} · Native llama-server:{" "}
            {platform.native ? "yes" : "no"}
            {platform.mlx ? " · MLX" : ""}
          </p>
        </section>
      )}
    </div>
  );
}
