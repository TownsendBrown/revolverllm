import { useState } from "react";
import { api, type CatalogModel, type PlatformCapabilities } from "../revolver";

type Props = {
  models: CatalogModel[];
  platform: PlatformCapabilities | null;
  onRefresh: () => void;
  onError: (message: string) => void;
};

function formatSize(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function sourceLabel(source: CatalogModel["source"]): string {
  if (source === "file") return "GGUF file";
  if (source === "hub") return "Hub";
  return "Local HF";
}

export default function InstalledModelsSection({ models, platform, onRefresh, onError }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const installed = models.filter((m) => m.hasWeights);

  const openModel = (path: string) => {
    api.openPath(path).then((err) => {
      if (err) onError(err);
    });
  };

  const deleteModel = async (model: CatalogModel) => {
    const label = model.displayName || model.id;
    if (
      !window.confirm(
        `Delete "${label}" from disk?\n\nThis cannot be undone. Server definitions that reference this model are not removed.`,
      )
    ) {
      return;
    }
    setBusyId(model.id);
    try {
      await api.deleteLocalModel(model.id);
      onRefresh();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="panel">
      <h3>Installed models</h3>
      {installed.length === 0 ? (
        <p className="muted">No models on disk. Download below.</p>
      ) : (
        <div className="installed-models-list">
          {installed.map((m) => (
            <div key={m.id} className={`model-card installed-model-card${m.loaded ? " loaded" : ""}`}>
              <div className="model-title">{m.displayName}</div>
              <div className="model-sub">{m.subtitle}</div>
              <div className="model-meta">
                <span className="pill">{sourceLabel(m.source)}</span>
                {m.format && <span className="pill">{m.format}</span>}
                {m.sizeBytes != null && <span>{formatSize(m.sizeBytes)}</span>}
                {m.loaded && <span className="pill loaded-pill">In use</span>}
              </div>
              <div className="installed-model-actions">
                {platform?.canOpenPath && m.path && (
                  <button type="button" className="ghost" onClick={() => openModel(m.path!)}>
                    Open folder
                  </button>
                )}
                <button
                  type="button"
                  className="ghost danger"
                  disabled={m.loaded || busyId === m.id}
                  title={m.loaded ? "Stop the server using this model first" : undefined}
                  onClick={() => void deleteModel(m)}
                >
                  {busyId === m.id ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
