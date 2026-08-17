import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type RuntimeId,
  type RuntimeInstallJob,
  type RuntimeStatus,
} from "../revolver";

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  onInstalled: () => void;
}

async function waitForJob(jobId: string): Promise<RuntimeInstallJob> {
  for (;;) {
    const job = await api.getRuntimeInstall(jobId);
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 700));
  }
}

export default function RuntimeSetupPanel({ onInstalled }: Props) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [jobs, setJobs] = useState<RuntimeInstallJob[]>([]);
  const [error, setError] = useState("");
  const [installingAll, setInstallingAll] = useState(false);
  const installedNotified = useRef(false);

  const refresh = useCallback(async () => {
    const [st, list] = await Promise.all([api.getRuntimesStatus(), api.listRuntimeInstalls()]);
    setStatus(st);
    setJobs(list);
    if (st.llamacpp.installed && st.mlx.installed && !installedNotified.current) {
      installedNotified.current = true;
      onInstalled();
    }
  }, [onInstalled]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");

  useEffect(() => {
    if (!activeJob) return;
    const id = setInterval(() => {
      api
        .getRuntimeInstall(activeJob.id)
        .then((job) => {
          setJobs((prev) => {
            const next = prev.filter((j) => j.id !== job.id);
            return [job, ...next];
          });
          if (job.status === "done") void refresh();
        })
        .catch(() => {});
    }, 800);
    return () => clearInterval(id);
  }, [activeJob?.id, activeJob?.status, refresh]);

  const install = async (runtimeId: RuntimeId) => {
    setError("");
    try {
      const job = await api.installRuntime(runtimeId);
      setJobs((prev) => [job, ...prev]);
      return job;
    } catch (e) {
      setError(String(e));
      return null;
    }
  };

  // Only one install job may run at a time, so chain the missing runtimes.
  const installAll = async (missing: RuntimeId[]) => {
    setInstallingAll(true);
    try {
      for (const runtimeId of missing) {
        const job = await install(runtimeId);
        if (!job) return;
        const done = await waitForJob(job.id);
        setJobs((prev) => [done, ...prev.filter((j) => j.id !== done.id)]);
        if (done.status !== "done") {
          setError(done.error ?? `${runtimeId} install failed`);
          return;
        }
      }
      await refresh();
    } finally {
      setInstallingAll(false);
    }
  };

  // Without a status there is nothing to install from, so the error is the only
  // thing worth rendering — staying blank would hide a broken install path.
  if (!status) {
    return error ? (
      <div className="runtime-setup panel">
        <div className="panel-head">
          <h2>Setup inference runtimes</h2>
        </div>
        <div className="banner error inline">{error}</div>
      </div>
    ) : null;
  }
  if (status.platform !== "darwin") return null;
  if (status.llamacpp.installed && status.mlx.installed) return null;

  // `jobs` is newest-first, so the first match per runtime is its latest job.
  const latestLlamaJob = jobs.find((j) => j.runtimeId === "llamacpp");
  const latestMlxJob = jobs.find((j) => j.runtimeId === "mlx");
  const isActive = (j?: RuntimeInstallJob) => j?.status === "running" || j?.status === "queued";
  // A job that finished while the runtime still fails detection means the tree
  // is unusable. Without this the card just offers "Install" again and the
  // broken install leaves no trace anywhere in the UI.
  const finishedButUnusable = (j: RuntimeInstallJob | undefined, installed: boolean) =>
    j?.status === "done" && !installed;
  const busy = Boolean(activeJob) || installingAll;
  const missing: RuntimeId[] = [
    ...(status.llamacpp.installed ? [] : (["llamacpp"] as RuntimeId[])),
    ...(status.mlx.installed ? [] : (["mlx"] as RuntimeId[])),
  ];

  return (
    <div className="runtime-setup panel">
      <div className="panel-head">
        <h2>Setup inference runtimes</h2>
      </div>
      <p className="runtime-setup-lead">
        Revolver downloads its engines from GitHub releases on first run. Both are
        required: llama.cpp (Metal) runs GGUF models, MLX runs safetensors / MLX
        quants on Apple Silicon.
      </p>
      {error && <div className="banner error inline">{error}</div>}

      {missing.length > 1 && (
        <button type="button" disabled={busy} onClick={() => void installAll(missing)}>
          Install both runtimes
        </button>
      )}

      <div className="runtime-setup-grid">
        <div className="runtime-setup-card">
          <h3>{status.catalog.llamacpp.label}</h3>
          <p className="muted">
            {formatMb(status.catalog.llamacpp.sizeBytes)} · tag {status.catalog.llamacpp.tag}
          </p>
          {status.llamacpp.installed ? (
            <p className="runtime-setup-ok">Installed</p>
          ) : isActive(latestLlamaJob) && latestLlamaJob ? (
            <div className="runtime-progress">
              <div className="runtime-progress-bar" style={{ width: `${latestLlamaJob.progress}%` }} />
              <span>{latestLlamaJob.phase} · {latestLlamaJob.progress}%</span>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => void install("llamacpp")}>
              Install llama.cpp
            </button>
          )}
          {latestLlamaJob?.status === "error" && (
            <p className="runtime-setup-error">{latestLlamaJob.error}</p>
          )}
          {finishedButUnusable(latestLlamaJob, status.llamacpp.installed) && (
            <p className="runtime-setup-error">
              Download finished but llama-server did not verify. Install again to replace the tree.
            </p>
          )}
        </div>

        <div className="runtime-setup-card">
          <h3>{status.catalog.mlx.label}</h3>
          <p className="muted">
            ~{formatMb(status.catalog.mlx.sizeBytes)} download · Python {status.catalog.mlx.pythonVersion} · mlx-engine {status.catalog.mlx.mlxEngineCommit}
          </p>
          {status.mlx.installed ? (
            <p className="runtime-setup-ok">Installed</p>
          ) : isActive(latestMlxJob) && latestMlxJob ? (
            <div className="runtime-progress">
              <div className="runtime-progress-bar" style={{ width: `${latestMlxJob.progress}%` }} />
              <span>{latestMlxJob.phase} · {latestMlxJob.progress}%</span>
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => void install("mlx")}>
              Install MLX
            </button>
          )}
          {latestMlxJob?.status === "error" && (
            <p className="runtime-setup-error">{latestMlxJob.error}</p>
          )}
          {finishedButUnusable(latestMlxJob, status.mlx.installed) && (
            <p className="runtime-setup-error">
              Download finished but the MLX Python failed its import check. Install again to replace
              the tree.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
