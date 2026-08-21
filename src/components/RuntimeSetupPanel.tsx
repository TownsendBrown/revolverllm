import { useRef, useState } from "react";
import {
  type RuntimeId,
  type RuntimeInstallJob,
} from "../revolver";
import {
  RuntimeCardGrid,
  useRuntimeInstalls,
  waitForRuntimeJob,
} from "./RuntimeCards";

interface Props {
  onInstalled: () => void;
}

export default function RuntimeSetupPanel({ onInstalled }: Props) {
  const { status, jobs, error, setError, refresh, install, activeJob } = useRuntimeInstalls();
  const [installingAll, setInstallingAll] = useState(false);
  const installedNotified = useRef(false);

  if (status?.llamacpp.installed && status.mlx.installed && !installedNotified.current) {
    installedNotified.current = true;
    onInstalled();
  }

  const installAll = async (missing: RuntimeId[]) => {
    setInstallingAll(true);
    try {
      for (const runtimeId of missing) {
        const job = await install(runtimeId);
        if (!job) return;
        const done = await waitForRuntimeJob(job.id);
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

  const busy = Boolean(activeJob) || installingAll;
  const missing: RuntimeId[] = [
    ...(status.llamacpp.installed ? [] : (["llamacpp"] as RuntimeId[])),
    ...(status.mlx.installed ? [] : (["mlx"] as RuntimeId[])),
  ];
  const cards = [
    {
      id: "llamacpp" as const,
      label: status.catalog.llamacpp.label,
      detail: `${(status.catalog.llamacpp.sizeBytes / (1024 * 1024)).toFixed(1)} MB · tag ${status.catalog.llamacpp.tag}`,
      installed: status.llamacpp.installed,
    },
    {
      id: "mlx" as const,
      label: status.catalog.mlx.label,
      detail: `~${(status.catalog.mlx.sizeBytes / (1024 * 1024)).toFixed(1)} MB download · Python ${status.catalog.mlx.pythonVersion} · mlx-engine ${status.catalog.mlx.mlxEngineCommit}`,
      installed: status.mlx.installed,
    },
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

      <RuntimeCardGrid
        cards={cards}
        jobs={jobs as RuntimeInstallJob[]}
        busy={busy}
        onInstall={(id) => void install(id)}
      />
    </div>
  );
}
