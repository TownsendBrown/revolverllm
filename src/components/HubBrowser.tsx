import { useCallback, useEffect, useRef, useState } from "react";
import { defaultHubPickedFiles, mergeWithCompanions } from "../../shared/hubDownloadFiles";
import {
  api,
  type DownloadJob,
  type HubModelSearchResult,
  type HubRepoFile,
  type HubFormatFilter,
  type HubSearchSort,
  type PlatformCapabilities,
  type RevolverSettingsView,
} from "../revolver";

type Props = {
  compact?: boolean;
  onDownloadComplete?: () => void;
};

type FileGroup = "gguf" | "safetensors" | "other";

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function parseGgufQuant(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const m = base.match(/\.([Qq]\d[_A-Za-z0-9]*|IQ\d[_A-Za-z0-9]*)\.gguf$/i);
  return m ? m[1].toUpperCase() : null;
}

function fileGroup(path: string): FileGroup {
  if (path.endsWith(".gguf")) return "gguf";
  if (path.endsWith(".safetensors")) return "safetensors";
  return "other";
}

function defaultPickedFiles(list: HubRepoFile[]): Set<string> {
  return new Set(defaultHubPickedFiles(list));
}

function weightFiles(list: HubRepoFile[]): HubRepoFile[] {
  return list.filter(
    (f) => f.path.endsWith(".gguf") || f.path.endsWith(".safetensors"),
  );
}

function groupFiles(list: HubRepoFile[]): { group: FileGroup; label: string; files: HubRepoFile[] }[] {
  const groups: { group: FileGroup; label: string; files: HubRepoFile[] }[] = [
    { group: "gguf", label: "GGUF", files: [] },
    { group: "safetensors", label: "Safetensors", files: [] },
    { group: "other", label: "Other", files: [] },
  ];
  for (const f of list) {
    groups.find((g) => g.group === fileGroup(f.path))!.files.push(f);
  }
  return groups.filter((g) => g.files.length > 0);
}

export default function HubBrowser({ compact, onDownloadComplete }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HubFormatFilter>("all");
  const [sort, setSort] = useState<HubSearchSort>("downloads");
  const [results, setResults] = useState<HubModelSearchResult[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedMeta, setSelectedMeta] = useState<HubModelSearchResult | null>(null);
  const [files, setFiles] = useState<HubRepoFile[]>([]);
  const [pickedFiles, setPickedFiles] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const hasSearched = useRef(false);

  const refreshJobs = useCallback(() => {
    api.listDownloads().then(setJobs).catch(() => {});
  }, []);

  useEffect(() => {
    refreshJobs();
    const t = setInterval(refreshJobs, 1000);
    return () => clearInterval(t);
  }, [refreshJobs]);

  const search = useCallback(async () => {
    setError("");
    setBusy("Searching…");
    try {
      const rows = await api.searchHubModels(query, filter, sort);
      setResults(rows);
      setSelectedRepo(null);
      setSelectedMeta(null);
      setFiles([]);
      setPickedFiles(new Set());
      hasSearched.current = true;
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }, [query, filter, sort]);

  useEffect(() => {
    if (!hasSearched.current) return;
    void search();
  }, [sort, filter]); // re-run when sort/filter changes after first search

  const selectRepo = async (repo: HubModelSearchResult) => {
    setSelectedRepo(repo.id);
    setSelectedMeta(repo);
    setError("");
    setBusy("Loading files…");
    try {
      const list = await api.listHubRepoFiles(repo.id);
      setFiles(list);
      setPickedFiles(defaultPickedFiles(list));
    } catch (e) {
      setError(String(e));
      setFiles([]);
      setPickedFiles(new Set());
    } finally {
      setBusy("");
    }
  };

  const toggleFile = (path: string) => {
    setPickedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectAllWeights = () => {
    const weights = weightFiles(files).map((f) => f.path);
    setPickedFiles(new Set(mergeWithCompanions(files.map((f) => f.path), weights)));
  };

  const selectNone = () => {
    setPickedFiles(new Set());
  };

  const startDownload = async () => {
    if (!selectedRepo) return;
    setError("");
    setBusy("Starting download…");
    try {
      await api.startModelDownload({
        repoId: selectedRepo,
        dest: "models",
        files: [...pickedFiles],
      });
      refreshJobs();
      onDownloadComplete?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  };

  const activeJob = jobs.find((j) => j.status === "running" || j.status === "queued");
  const selectedTotal = files
    .filter((f) => pickedFiles.has(f.path))
    .reduce((sum, f) => sum + (f.size ?? 0), 0);
  const fileGroups = groupFiles(files);

  return (
    <div className={compact ? "hub-browser compact" : "hub-browser"}>
      <div className="hub-search-row">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search Hugging Face models…"
          onKeyDown={(e) => e.key === "Enter" && void search()}
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as HubFormatFilter)}>
          <option value="all">All</option>
          <option value="gguf">GGUF</option>
          <option value="safetensors">Safetensors</option>
          <option value="mlx">MLX</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as HubSearchSort)}>
          <option value="downloads">Downloads</option>
          <option value="likes">Likes</option>
          <option value="lastModified">Recently updated</option>
          <option value="trendingScore">Trending</option>
        </select>
        <button className="primary" onClick={() => void search()} disabled={!!busy}>
          Search
        </button>
      </div>

      {error && <p className="banner error inline">{error}</p>}
      {busy && <p className="muted small">{busy}</p>}

      {activeJob && (
        <div className="download-progress panel">
          <strong>{activeJob.repoId}</strong>
          <span>
            {activeJob.status} · {activeJob.progress}%
            {activeJob.bytesTotal != null &&
              ` · ${formatBytes(activeJob.bytesDone)} / ${formatBytes(activeJob.bytesTotal)}`}
          </span>
          <button className="ghost" onClick={() => void api.cancelDownload(activeJob.id).then(refreshJobs)}>
            Cancel
          </button>
        </div>
      )}

      <div className="hub-columns">
        <div className="hub-results">
          {results.length === 0 && hasSearched.current && !busy && (
            <p className="muted small">No models found.</p>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`model-card hub-result-card ${selectedRepo === r.id ? "sel" : ""}`}
              onClick={() => void selectRepo(r)}
            >
              <div className="model-title">{r.id}</div>
              <div className="model-meta hub-result-meta">
                {r.sizeBytes != null && <span className="pill">{formatBytes(r.sizeBytes)}</span>}
                <span className="pill">{r.downloads.toLocaleString()} dl</span>
                <span className="pill">{r.likes.toLocaleString()} likes</span>
                {r.gated && <span className="pill">gated</span>}
                {r.pipeline_tag && <span className="pill">{r.pipeline_tag}</span>}
              </div>
              <div className="model-sub">
                {r.author} · {formatShortDate(r.lastModified)}
              </div>
            </button>
          ))}
        </div>

        {selectedRepo && (
          <div className="hub-files panel">
            <div className="hub-preview-head">
              <h4>{selectedRepo}</h4>
              {selectedMeta?.gated && <span className="pill">gated</span>}
            </div>
            {selectedMeta && (
              <p className="hub-preview-summary muted small">
                {selectedMeta.author} · {formatShortDate(selectedMeta.lastModified)} ·{" "}
                {selectedMeta.downloads.toLocaleString()} downloads · {selectedMeta.likes.toLocaleString()} likes
                {selectedMeta.sizeBytes != null && ` · repo ~${formatBytes(selectedMeta.sizeBytes)}`}
              </p>
            )}

            {files.length === 0 ? (
              <p className="muted small">No files listed for this repo.</p>
            ) : (
              <>
                <p className="hub-selected-total">
                  Selected: <strong>{formatBytes(selectedTotal || null)}</strong>
                  {pickedFiles.size > 0 && (
                    <span className="muted small"> · {pickedFiles.size} file{pickedFiles.size !== 1 ? "s" : ""}</span>
                  )}
                </p>
                <div className="hub-file-actions">
                  <button type="button" className="ghost" onClick={selectAllWeights}>
                    Select weights
                  </button>
                  <button type="button" className="ghost" onClick={selectNone}>
                    Select none
                  </button>
                </div>
                <div className="hub-file-list">
                  {fileGroups.map(({ group, label, files: groupFilesList }) => (
                    <div key={group} className="hub-file-group">
                      <div className="hub-file-group-label">{label}</div>
                      {groupFilesList.map((f) => {
                        const quant = group === "gguf" ? parseGgufQuant(f.path) : null;
                        return (
                          <label key={f.path} className="hub-file-row">
                            <input
                              type="checkbox"
                              checked={pickedFiles.has(f.path)}
                              onChange={() => toggleFile(f.path)}
                            />
                            <span className="hub-file-name">{f.path.split("/").pop() ?? f.path}</span>
                            {quant && <span className="pill">{quant}</span>}
                            <span className="muted small hub-file-size">{formatBytes(f.size)}</span>
                          </label>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <button
                  className="primary"
                  disabled={pickedFiles.size === 0 || !!activeJob}
                  onClick={() => void startDownload()}
                >
                  Download selected
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function HubBrowserSettingsSection({
  settings,
  platform,
  compact = true,
  onSaved,
  onError,
}: {
  settings: RevolverSettingsView | null;
  platform: PlatformCapabilities | null;
  compact?: boolean;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [hfToken, setHfTokenInput] = useState("");

  if (!settings) return null;

  return (
    <section className="panel">
      <h3>Hugging Face</h3>
      <p className="muted">
        Token for gated models and downloads. Never stored in settings JSON
        {settings.hfTokenSet ? " — token is saved" : ""}.
      </p>
      <div className="config-form">
        <label>
          HF token
          <input
            type="password"
            value={hfToken}
            placeholder={settings.hfTokenSet ? "•••••••• (saved)" : "hf_…"}
            onChange={(e) => setHfTokenInput(e.target.value)}
          />
        </label>
        <button
          className="primary"
          onClick={() =>
            api
              .setHfToken(hfToken)
              .then(() => {
                setHfTokenInput("");
                onSaved();
              })
              .catch((e) => onError(String(e)))
          }
          disabled={!hfToken.trim()}
        >
          Save token
        </button>
        {settings.hfTokenSet && (
          <button
            type="button"
            onClick={() =>
              api
                .clearHfToken()
                .then(onSaved)
                .catch((e) => onError(String(e)))
            }
          >
            Clear token
          </button>
        )}
      </div>
      <HubBrowser compact={compact} onDownloadComplete={onSaved} />
      {platform?.pathSettingsLocked && (
        <p className="field-hint">Downloads land under mounted MODELS_DIR / hub.</p>
      )}
    </section>
  );
}
