import { useCallback, useEffect, useState } from "react";
import {
  api,
  type RuntimeId,
  type RuntimeInstallJob,
  type RuntimeStatus,
} from "../revolver";

export function formatRuntimeMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function waitForRuntimeJob(jobId: string): Promise<RuntimeInstallJob> {
  for (;;) {
    const job = await api.getRuntimeInstall(jobId);
    if (job.status !== "queued" && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 700));
  }
}

export function isRuntimeJobActive(j?: RuntimeInstallJob): boolean {
  return j?.status === "running" || j?.status === "queued";
}

export function finishedButUnusable(j: RuntimeInstallJob | undefined, installed: boolean): boolean {
  return j?.status === "done" && !installed;
}

export interface RuntimeCardModel {
  id: RuntimeId;
  label: string;
  detail: string;
  installed: boolean;
  recommended?: boolean;
}

export function RuntimeCard({
  card,
  job,
  busy,
  onInstall,
}: {
  card: RuntimeCardModel;
  job?: RuntimeInstallJob;
  busy: boolean;
  onInstall: (id: RuntimeId) => void;
}) {
  return (
    <div className="runtime-setup-card">
      <h3>
        {card.label}
        {card.recommended ? <span className="backend-rec"> Recommended</span> : null}
      </h3>
      <p className="muted">{card.detail}</p>
      {card.installed ? (
        <p className="runtime-setup-ok">Installed</p>
      ) : isRuntimeJobActive(job) && job ? (
        <div className="runtime-progress">
          <div className="runtime-progress-bar" style={{ width: `${job.progress}%` }} />
          <span>
            {job.phase} · {job.progress}%
          </span>
        </div>
      ) : (
        <button type="button" disabled={busy} onClick={() => onInstall(card.id)}>
          Install
        </button>
      )}
      {job?.status === "error" && <p className="runtime-setup-error">{job.error}</p>}
      {finishedButUnusable(job, card.installed) && (
        <p className="runtime-setup-error">
          Download finished but the runtime did not verify. Install again to replace the tree.
        </p>
      )}
    </div>
  );
}

export function RuntimeCardGrid({
  cards,
  jobs,
  busy,
  onInstall,
}: {
  cards: RuntimeCardModel[];
  jobs: RuntimeInstallJob[];
  busy: boolean;
  onInstall: (id: RuntimeId) => void;
}) {
  return (
    <div className="runtime-setup-grid">
      {cards.map((card) => (
        <RuntimeCard
          key={card.id}
          card={card}
          job={jobs.find((j) => j.runtimeId === card.id)}
          busy={busy}
          onInstall={onInstall}
        />
      ))}
    </div>
  );
}

export function useRuntimeInstalls() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [jobs, setJobs] = useState<RuntimeInstallJob[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const [st, list] = await Promise.all([api.getRuntimesStatus(), api.listRuntimeInstalls()]);
    setStatus(st);
    setJobs(list);
    return st;
  }, []);

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

  return { status, jobs, error, setError, refresh, install, activeJob };
}

export function linuxRuntimeCards(status: RuntimeStatus): RuntimeCardModel[] {
  const rec = status.recommendedLinuxId;
  return status.catalog.linux.map((entry) => {
    const inst = status.linux.find((s) => s.id === entry.id);
    return {
      id: entry.id,
      label: entry.label,
      detail: `${formatRuntimeMb(entry.sizeBytes)} · tag ${entry.tag ?? "—"} · ${entry.backend ?? ""}`,
      installed: Boolean(inst?.installed),
      recommended: rec === entry.id,
    };
  });
}
