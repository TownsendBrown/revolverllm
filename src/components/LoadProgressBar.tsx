import type { LoadProgress } from "../revolver";

type Props = {
  progress: LoadProgress;
  compact?: boolean;
};

function formatElapsed(ms?: number) {
  if (ms == null) return null;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function LoadProgressBar({ progress, compact }: Props) {
  const elapsed = formatElapsed(progress.elapsedMs);

  return (
    <div className={`load-progress ${compact ? "compact" : ""}`}>
      <div className="load-progress-head">
        <span className="load-progress-stage">{progress.stage}</span>
        <span className="load-progress-pct">
          {elapsed && <span className="load-elapsed">{elapsed} · </span>}
          {progress.percent}%
        </span>
      </div>
      <div className="load-progress-track">
        <div
          className={`load-progress-fill ${progress.percent >= 100 ? "done" : progress.percent < 100 ? "active" : ""}`}
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      {!compact && progress.steps.length > 0 && (
        <ol className="load-progress-steps">
          {progress.steps.map((s) => (
            <li key={s.id} className={s.status}>
              <span className="load-step-dot" />
              {s.label}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
