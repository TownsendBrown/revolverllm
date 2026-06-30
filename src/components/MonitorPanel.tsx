import { useCallback, useEffect, useState } from "react";
import { api, type MonitorSnapshot } from "../revolver";

function gb(n: number): string {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function UtilBar({
  label,
  value,
  detail,
  tone = "blue",
}: {
  label: string;
  value: number | null;
  detail?: string;
  tone?: "blue" | "green" | "amber";
}) {
  const pct = value != null ? Math.min(100, Math.max(0, value)) : null;
  return (
    <div className="util-row">
      <div className="util-head">
        <span>{label}</span>
        <span className="util-value">
          {pct != null ? `${pct.toFixed(1)}%` : "—"}
          {detail && <span className="util-detail">{detail}</span>}
        </span>
      </div>
      <div className="util-track">
        {pct != null && (
          <div className={`util-fill ${tone}`} style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}

export default function MonitorPanel() {
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [error, setError] = useState("");
  const [polling, setPolling] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getMonitor();
      setSnapshot(data);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => {
      refresh().catch((e) => setError(String(e)));
    }, 1500);
    return () => clearInterval(t);
  }, [polling, refresh]);

  const sys = snapshot?.system;
  const gpu = snapshot?.gpu;

  return (
    <div className="monitor-layout">
      <div className="monitor-toolbar">
        <span className="muted">
          {snapshot ? `Updated ${new Date(snapshot.timestamp).toLocaleTimeString()}` : "Loading…"}
        </span>
        <div className="monitor-toolbar-actions">
          <label className="monitor-live">
            <input type="checkbox" checked={polling} onChange={(e) => setPolling(e.target.checked)} />
            Live
          </label>
          <button className="ghost" onClick={() => refresh()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="banner error monitor-error">{error}</div>}

      <section className="panel monitor-section">
        <h3>System</h3>
        {!sys && !error && <p className="muted">Collecting metrics…</p>}
        {sys && (
          <>
            <p className="monitor-meta">
              <strong>{sys.hostname}</strong> · {sys.platform} · {sys.cpuCount} cores · uptime{" "}
              {fmtUptime(sys.uptimeSeconds)}
            </p>
            <p className="monitor-cpu-model muted">{sys.cpuModel}</p>

            <div className="util-grid">
              <UtilBar
                label="CPU"
                value={sys.cpuUsagePercent}
                detail={`load ${sys.loadAvg1} / ${sys.loadAvg5} / ${sys.loadAvg15}`}
              />
              <UtilBar
                label="Memory"
                value={sys.memoryUsedPercent}
                detail={`${gb(sys.memoryUsedBytes)} / ${gb(sys.memoryTotalBytes)}`}
                tone="green"
              />
              {sys.diskUsedPercent != null && sys.diskTotalBytes != null && (
                <UtilBar
                  label="Disk (/)"
                  value={sys.diskUsedPercent}
                  detail={
                    sys.diskUsedBytes != null
                      ? `${gb(sys.diskUsedBytes)} / ${gb(sys.diskTotalBytes)}`
                      : undefined
                  }
                  tone="amber"
                />
              )}
              {sys.swapTotalBytes != null && sys.swapTotalBytes > 0 && (
                <UtilBar
                  label="Swap"
                  value={
                    sys.swapUsedBytes != null
                      ? Math.round((sys.swapUsedBytes / sys.swapTotalBytes) * 1000) / 10
                      : null
                  }
                  detail={
                    sys.swapUsedBytes != null
                      ? `${gb(sys.swapUsedBytes)} / ${gb(sys.swapTotalBytes)}`
                      : undefined
                  }
                />
              )}
            </div>

            <div className="monitor-stat-row">
              <div className="monitor-stat">
                <span className="monitor-stat-label">Load avg (1m)</span>
                <span className="monitor-stat-value">{sys.loadAvg1}</span>
              </div>
              <div className="monitor-stat">
                <span className="monitor-stat-label">Load avg (5m)</span>
                <span className="monitor-stat-value">{sys.loadAvg5}</span>
              </div>
              <div className="monitor-stat">
                <span className="monitor-stat-label">Load avg (15m)</span>
                <span className="monitor-stat-value">{sys.loadAvg15}</span>
              </div>
              <div className="monitor-stat">
                <span className="monitor-stat-label">Free RAM</span>
                <span className="monitor-stat-value">{gb(sys.memoryFreeBytes)}</span>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="panel monitor-section">
        <h3>GPU</h3>
        {!gpu?.available && (
          <p className="muted">
            {gpu?.error ? `No GPU data: ${gpu.error}` : "No GPU detected"}
          </p>
        )}
        {gpu?.available && (
          <>
            <p className="gpu-summary">
              {gpu.deviceCount} GPU{gpu.deviceCount !== 1 ? "s" : ""} ·{" "}
              <strong>{gb(gpu.totalVramBytes)}</strong> VRAM ·{" "}
              <strong>{gb(gpu.totalFreeVramBytes)}</strong> free
            </p>
            <div className="monitor-gpu-grid">
              {gpu.devices.map((d) => (
                <div key={d.index} className="monitor-gpu-card">
                  <div className="monitor-gpu-head">
                    <strong>GPU {d.index}</strong>
                    <span className="muted">{d.name}</span>
                  </div>
                  <UtilBar
                    label="GPU utilization"
                    value={d.gpuUtilPercent ?? null}
                    tone="green"
                  />
                  <UtilBar
                    label="VRAM"
                    value={d.usedPercent ?? null}
                    detail={`${d.freeGb} / ${d.totalGb} GB free`}
                  />
                  {d.memUtilPercent != null && (
                    <UtilBar label="VRAM controller" value={d.memUtilPercent} tone="amber" />
                  )}
                  <div className="monitor-gpu-foot">
                    {d.temperatureC != null && <span>{d.temperatureC}°C</span>}
                    {d.powerW != null && <span>{d.powerW} W</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
