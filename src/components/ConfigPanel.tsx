import { useCallback, useEffect, useState } from "react";
import { api, type GpuInfo, type RevolverConfig, type RuntimeConfig, type ServerConfig } from "../revolver";
import { vendorLabel } from "../../shared/gpuDevices";

type Props = {
  config: RevolverConfig | null;
  configDraft: RevolverConfig;
  setConfigDraft: (c: RevolverConfig) => void;
  gpu: GpuInfo | null;
  onSavePaths: () => void;
  onRefresh: () => void;
  onError: (message: string) => void;
};

function gb(n: number) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export default function ConfigPanel({
  config,
  configDraft,
  setConfigDraft,
  gpu,
  onSavePaths,
  onRefresh,
  onError,
}: Props) {
  const [runtimeDraft, setRuntimeDraft] = useState<RuntimeConfig | null>(null);
  const [gatewayDraft, setGatewayDraft] = useState<ServerConfig | null>(null);

  useEffect(() => {
    api.getRuntimeConfig().then(setRuntimeDraft);
    api.getServerConfig().then(setGatewayDraft);
  }, []);

  const saveRuntime = useCallback(async () => {
    if (!runtimeDraft) return;
    await api.setRuntimeConfig(runtimeDraft);
    onRefresh();
  }, [runtimeDraft, onRefresh]);

  const saveGateway = useCallback(async () => {
    if (!gatewayDraft) return;
    await api.setServerConfig(gatewayDraft);
    onRefresh();
  }, [gatewayDraft, onRefresh]);

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
        <h3>Default load settings</h3>
        <p className="muted">
          Starting values for the Server tab. Per-model context can be changed before each load.
        </p>
        {runtimeDraft && (
          <div className="config-form">
            <label>
              Default context length
              <input
                type="number"
                min={512}
                max={131072}
                value={runtimeDraft.contextLength}
                onChange={(e) =>
                  setRuntimeDraft({ ...runtimeDraft, contextLength: Number(e.target.value) })
                }
              />
              <span className="field-hint">Used when Server tab opens. Override per model before load.</span>
            </label>
            <label>
              GPU layers (-1 = all)
              <input
                type="number"
                value={runtimeDraft.nGpuLayers}
                onChange={(e) =>
                  setRuntimeDraft({ ...runtimeDraft, nGpuLayers: Number(e.target.value) })
                }
              />
            </label>
            <label>
              KV cache dtype
              <select
                value={runtimeDraft.kvCacheDtype}
                onChange={(e) =>
                  setRuntimeDraft({ ...runtimeDraft, kvCacheDtype: e.target.value })
                }
              >
                <option value="f16">f16</option>
                <option value="f32">f32</option>
                <option value="q8_0">q8_0</option>
                <option value="q4_0">q4_0</option>
              </select>
            </label>
            <button className="primary" onClick={saveRuntime}>
              Save defaults
            </button>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>OpenAI gateway</h3>
        <p className="muted">
          Unified endpoint for external clients (Cline, Continue, etc.). Routes requests to running
          servers by model name.
        </p>
        {gatewayDraft && (
          <div className="config-form">
            <label>
              <input
                type="checkbox"
                checked={gatewayDraft.gatewayEnabled !== false}
                onChange={(e) =>
                  setGatewayDraft({ ...gatewayDraft, gatewayEnabled: e.target.checked })
                }
              />{" "}
              Gateway enabled
            </label>
            <label>
              Host
              <input
                value={gatewayDraft.host}
                onChange={(e) => setGatewayDraft({ ...gatewayDraft, host: e.target.value })}
              />
              <span className="field-hint">Use 127.0.0.1 for local-only access.</span>
            </label>
            <label>
              Port
              <input
                type="number"
                min={1024}
                max={65535}
                value={gatewayDraft.port}
                onChange={(e) =>
                  setGatewayDraft({ ...gatewayDraft, port: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Gateway API key (optional)
              <input
                type="password"
                value={gatewayDraft.gatewayApiKey ?? ""}
                placeholder="Leave empty for open access"
                onChange={(e) =>
                  setGatewayDraft({
                    ...gatewayDraft,
                    gatewayApiKey: e.target.value.trim() || null,
                  })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={gatewayDraft.cors}
                onChange={(e) => setGatewayDraft({ ...gatewayDraft, cors: e.target.checked })}
              />{" "}
              Enable CORS (browser clients)
            </label>
            <p className="mono small muted">
              Base URL: http://{gatewayDraft.host === "0.0.0.0" ? "127.0.0.1" : gatewayDraft.host}:
              {gatewayDraft.port}/v1
            </p>
            <button className="primary" onClick={saveGateway}>
              Save gateway settings
            </button>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Model directories</h3>
        <div className="config-form">
          <label>
            GGUF models
            <input
              value={configDraft.modelsDir}
              onChange={(e) => setConfigDraft({ ...configDraft, modelsDir: e.target.value })}
            />
          </label>
          <button className="primary" onClick={onSavePaths}>
            Save paths
          </button>
          {config && (
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

      <section className="panel">
        <h3>Inference</h3>
        <p className="muted">
          Models run in the <code>llama-server</code> Docker container (llama.cpp). Requires Docker on
          the host.
        </p>
      </section>
    </div>
  );
}
