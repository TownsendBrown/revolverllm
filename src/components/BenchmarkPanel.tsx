import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type BenchmarkCheckResult,
  type BenchmarkDefinition,
  type BenchmarkRun,
  type BenchmarkTestResult,
  type ServerInstanceStatus,
} from "../revolver";
import { loadHtmlPreview } from "../lib/benchmarkArtifacts";

type Props = {
  servers: ServerInstanceStatus[];
  onError: (msg: string) => void;
};

type View = "history" | "new" | "detail";

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function formatScore(result: BenchmarkTestResult): string {
  if (result.combinedScore != null) return `${result.combinedScore}%`;
  if (result.automatedScore != null && result.automatedMaxScore) {
    return `${result.automatedScore}/${result.automatedMaxScore}`;
  }
  return "—";
}

/** Score metrics, run-validity checks, and everything else are read differently. */
function partitionChecks(checks: BenchmarkCheckResult[]) {
  return {
    scores: checks.filter((c) => c.kind === "score"),
    health: checks.filter((c) => c.kind === "health"),
    rest: checks.filter((c) => c.kind !== "score" && c.kind !== "health"),
  };
}

/** "pass@1 = 12.3%" → name and value, so the chip can lay them out separately. */
function splitMetricLabel(check: BenchmarkCheckResult): { name: string; value: string } {
  const idx = check.label.lastIndexOf(" = ");
  if (idx < 0) return { name: check.label, value: "n/a" };
  return { name: check.label.slice(0, idx), value: check.label.slice(idx + 3) };
}

function artifactName(path: string): string {
  return path.split("/").pop() ?? path;
}

function statusClass(status: string): string {
  switch (status) {
    case "completed":
    case "ready":
      return "bench-status-ok";
    case "running":
    case "pending":
      return "bench-status-run";
    case "failed":
      return "bench-status-fail";
    case "cancelled":
    case "skipped":
      return "bench-status-muted";
    default:
      return "";
  }
}

function runningServers(servers: ServerInstanceStatus[]) {
  return servers.filter((s) => s.running && s.loadPhase === "ready");
}

export default function BenchmarkPanel({ servers, onError }: Props) {
  const [view, setView] = useState<View>("history");
  const [definitions, setDefinitions] = useState<BenchmarkDefinition[]>([]);
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [serverId, setServerId] = useState("");
  const [selectedTests, setSelectedTests] = useState<Set<string>>(new Set());
  const [enableThinking, setEnableThinking] = useState(false);

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [humanScoreDraft, setHumanScoreDraft] = useState("");
  const [humanNotesDraft, setHumanNotesDraft] = useState("");
  const [openArtifact, setOpenArtifact] = useState<{ name: string; content: string } | null>(null);

  const readyServers = useMemo(() => runningServers(servers), [servers]);

  const selectedRun = useMemo(
    () => runs.find((r) => r.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );

  const selectedTest = useMemo(() => {
    if (!selectedRun || !selectedTestId) return null;
    return selectedRun.results.find((r) => r.testId === selectedTestId) ?? null;
  }, [selectedRun, selectedTestId]);

  const checkGroups = useMemo(() => partitionChecks(selectedTest?.checks ?? []), [selectedTest]);
  const healthFailures = useMemo(
    () => checkGroups.health.filter((c) => !c.passed),
    [checkGroups],
  );

  const runsByModel = useMemo(() => {
    const map = new Map<string, BenchmarkRun[]>();
    for (const run of runs) {
      const key = run.config.modelDisplayName ?? run.config.modelId ?? "Unknown model";
      const list = map.get(key) ?? [];
      list.push(run);
      map.set(key, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [runs]);

  const refresh = useCallback(async () => {
    try {
      const [defs, allRuns] = await Promise.all([
        api.listBenchmarkDefinitions(),
        api.listBenchmarkRuns(),
      ]);
      setDefinitions(defs);
      setRuns(allRuns);
      if (selectedRunId) {
        const updated = allRuns.find((r) => r.id === selectedRunId);
        if (updated) {
          setSelectedRunId(updated.id);
        }
      }
    } catch (e) {
      onError(String(e));
    } finally {
      setLoading(false);
    }
  }, [onError, selectedRunId]);

  useEffect(() => {
    refresh().catch((e) => onError(String(e)));
  }, [refresh, onError]);

  useEffect(() => {
    const active = runs.some((r) => r.status === "running" || r.status === "pending");
    if (!active) return;
    const t = setInterval(() => {
      refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [runs, refresh]);

  useEffect(() => {
    if (definitions.length && selectedTests.size === 0) {
      setSelectedTests(new Set(definitions.map((d) => d.id)));
    }
  }, [definitions, selectedTests.size]);

  useEffect(() => {
    if (!serverId && readyServers.length === 1) {
      setServerId(readyServers[0].definition.id);
    }
  }, [readyServers, serverId]);

  useEffect(() => {
    let blobUrl: string | null = null;
    let cancelled = false;

    async function loadPreview() {
      if (!selectedRun || !selectedTest) {
        setPreviewUrl(null);
        return;
      }
      const hasHtml = selectedTest.artifacts.some((a) => a.endsWith("index.html"));
      if (!hasHtml) {
        setPreviewUrl(null);
        return;
      }
      try {
        const url = await loadHtmlPreview(
          selectedRun.id,
          selectedTest.testId,
          api.readBenchmarkArtifact,
        );
        if (cancelled) {
          if (url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        blobUrl = url.startsWith("blob:") ? url : null;
        setPreviewUrl(url);
      } catch {
        setPreviewUrl(null);
      }
    }

    loadPreview().catch(() => setPreviewUrl(null));
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [selectedRun, selectedTest]);

  useEffect(() => {
    if (selectedTest) {
      setHumanScoreDraft(selectedTest.humanScore != null ? String(selectedTest.humanScore) : "");
      setHumanNotesDraft(selectedTest.humanNotes ?? "");
    }
    setOpenArtifact(null);
  }, [selectedTest]);

  const showArtifact = async (relPath: string) => {
    if (!selectedRun || !selectedTest) return;
    const name = artifactName(relPath);
    if (openArtifact?.name === name) {
      setOpenArtifact(null);
      return;
    }
    try {
      const content = await api.readBenchmarkArtifact(selectedRun.id, selectedTest.testId, name);
      setOpenArtifact({ name, content });
    } catch (e) {
      onError(String(e));
    }
  };

  const toggleTest = (id: string) => {
    setSelectedTests((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startRun = async () => {
    if (!serverId) {
      onError("Select a running server");
      return;
    }
    if (selectedTests.size === 0) {
      onError("Select at least one benchmark");
      return;
    }
    setBusy(true);
    try {
      const run = await api.startBenchmarkRun({
        serverId,
        testIds: [...selectedTests] as BenchmarkDefinition["id"][],
        enableThinking,
      });
      setSelectedRunId(run.id);
      setView("detail");
      await refresh();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelRun = async (id: string) => {
    try {
      await api.cancelBenchmarkRun(id);
      await refresh();
    } catch (e) {
      onError(String(e));
    }
  };

  const deleteRun = async (id: string) => {
    try {
      await api.deleteBenchmarkRun(id);
      if (selectedRunId === id) {
        setSelectedRunId(null);
        setSelectedTestId(null);
        setView("history");
      }
      await refresh();
    } catch (e) {
      onError(String(e));
    }
  };

  const saveHumanScore = async () => {
    if (!selectedRun || !selectedTest) return;
    const score = Number(humanScoreDraft);
    if (!Number.isFinite(score)) {
      onError("Enter a valid human score");
      return;
    }
    try {
      await api.setBenchmarkHumanScore(
        selectedRun.id,
        selectedTest.testId,
        score,
        selectedTest.humanMaxScore ?? 10,
        humanNotesDraft,
      );
      await refresh();
    } catch (e) {
      onError(String(e));
    }
  };

  const defName = (id: string) => definitions.find((d) => d.id === id)?.name ?? id;

  return (
    <div className="bench-layout">
      <aside className="bench-sidebar panel">
        <div className="panel-head">
          <h3>Runs</h3>
          <button className="ghost small" onClick={() => setView("new")}>
            New
          </button>
        </div>

        {loading && <p className="muted bench-empty">Loading…</p>}
        {!loading && runs.length === 0 && (
          <p className="muted bench-empty">No benchmark runs yet.</p>
        )}

        {runsByModel.map(([model, modelRuns]) => (
          <div key={model} className="bench-model-group">
            <div className="bench-model-label">{model}</div>
            {modelRuns.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`bench-run-item ${selectedRunId === run.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.id);
                  setSelectedTestId(null);
                  setView("detail");
                }}
              >
                <span className={`bench-run-status ${statusClass(run.status)}`} />
                <span className="bench-run-meta">
                  <span className="bench-run-date">{formatDate(run.createdAt)}</span>
                  <span className={`bench-run-phase ${statusClass(run.status)}`}>{run.status}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className="bench-main">
        {view === "new" && (
          <section className="panel bench-config">
            <div className="panel-head">
              <h3>New benchmark run</h3>
              <button className="ghost" onClick={() => setView("history")}>
                Cancel
              </button>
            </div>

            {readyServers.length === 0 ? (
              <p className="bench-hint">
                Start a server in the <strong>Server</strong> tab before running benchmarks.
              </p>
            ) : (
              <>
                <label>
                  Server
                  <select value={serverId} onChange={(e) => setServerId(e.target.value)}>
                    <option value="">Select server…</option>
                    {readyServers.map((s) => (
                      <option key={s.definition.id} value={s.definition.id}>
                        {s.definition.name} — {s.loaded?.modelId?.split("/").pop() ?? s.definition.modelId}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={enableThinking}
                    onChange={(e) => setEnableThinking(e.target.checked)}
                  />
                  Enable thinking / reasoning
                </label>

                <div className="bench-test-picker">
                  <div className="bench-test-picker-head">
                    <strong>Tests</strong>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() =>
                        setSelectedTests(
                          selectedTests.size === definitions.length
                            ? new Set()
                            : new Set(definitions.map((d) => d.id)),
                        )
                      }
                    >
                      {selectedTests.size === definitions.length ? "Clear all" : "Select all"}
                    </button>
                  </div>
                  {definitions.map((def) => (
                    <label key={def.id} className="bench-test-option check-row">
                      <input
                        type="checkbox"
                        checked={selectedTests.has(def.id)}
                        onChange={() => toggleTest(def.id)}
                      />
                      <span>
                        <strong>{def.name}</strong>
                        <span className="muted bench-test-desc">{def.description}</span>
                      </span>
                    </label>
                  ))}
                </div>

                <div className="bench-actions">
                  <button disabled={busy} onClick={() => startRun()}>
                    {busy ? "Starting…" : "Run benchmarks"}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {view !== "new" && !selectedRun && (
          <section className="panel bench-empty-state">
            <h3>Benchmarks</h3>
            <p className="muted">
              Compare models with automated tests. History is grouped by model on the left.
            </p>
            <button onClick={() => setView("new")}>Configure new run</button>
          </section>
        )}

        {view !== "new" && selectedRun && (
          <div className="bench-detail">
            <section className="panel bench-summary">
              <div className="panel-head">
                <h3>{selectedRun.config.modelDisplayName ?? "Benchmark run"}</h3>
                <div className="bench-summary-actions">
                  {(selectedRun.status === "running" || selectedRun.status === "pending") && (
                    <button className="ghost" onClick={() => cancelRun(selectedRun.id)}>
                      Cancel
                    </button>
                  )}
                  <button className="ghost danger" onClick={() => deleteRun(selectedRun.id)}>
                    Delete
                  </button>
                </div>
              </div>
              <div className="bench-summary-grid">
                <span>
                  <strong>Status</strong>{" "}
                  <span className={statusClass(selectedRun.status)}>{selectedRun.status}</span>
                </span>
                <span>
                  <strong>Engine</strong> {selectedRun.config.engineId} / {selectedRun.config.backendId}
                </span>
                <span>
                  <strong>Context</strong> {selectedRun.config.contextLength?.toLocaleString() ?? "—"}
                </span>
                <span>
                  <strong>Started</strong>{" "}
                  {selectedRun.startedAt ? formatDate(selectedRun.startedAt) : "—"}
                </span>
              </div>
              {selectedRun.error && <div className="banner error">{selectedRun.error}</div>}
            </section>

            <div className="bench-split">
              <section className="panel bench-results">
                <h3>Results</h3>
                <div className="bench-result-list">
                  {selectedRun.results.map((result) => (
                    <button
                      key={result.testId}
                      type="button"
                      className={`bench-result-row ${selectedTestId === result.testId ? "active" : ""}`}
                      onClick={() => setSelectedTestId(result.testId)}
                    >
                      <span className="bench-result-name">{defName(result.testId)}</span>
                      <span className={`bench-result-status ${statusClass(result.status)}`}>
                        {result.status}
                      </span>
                      <span className="bench-result-score">{formatScore(result)}</span>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel bench-test-detail">
                {!selectedTest && <p className="muted">Select a test to inspect results.</p>}
                {selectedTest && (
                  <>
                    <h3>{defName(selectedTest.testId)}</h3>

                    {checkGroups.scores.length > 0 && (
                      <div className="bench-metric-chips">
                        {checkGroups.scores.map((c) => {
                          const { name, value } = splitMetricLabel(c);
                          return (
                            <div
                              key={c.id}
                              className={`bench-metric-chip ${c.value == null ? "unavailable" : ""}`}
                            >
                              <span className="bench-metric-value">{value}</span>
                              <span className="bench-metric-name">{name}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="bench-score-row">
                      <span>
                        Automated:{" "}
                        {selectedTest.automatedScore != null
                          ? `${selectedTest.automatedScore}/${selectedTest.automatedMaxScore}` +
                            (selectedTest.automatedMaxScore
                              ? ` (${Math.round(
                                  (selectedTest.automatedScore / selectedTest.automatedMaxScore) * 100,
                                )}%)`
                              : "")
                          : "—"}
                      </span>
                      <span>
                        Human:{" "}
                        {selectedTest.humanScore != null
                          ? `${selectedTest.humanScore}/${selectedTest.humanMaxScore}`
                          : "—"}
                      </span>
                      <span>
                        Combined: {selectedTest.combinedScore != null ? `${selectedTest.combinedScore}%` : "—"}
                      </span>
                    </div>

                    {selectedTest.error && (
                      <div className="banner error bench-test-error">{selectedTest.error}</div>
                    )}

                    {healthFailures.length > 0 && (
                      <div className="banner warn bench-health-warning">
                        <strong>Run health</strong>
                        <p>
                          These scores may not reflect the model — the run itself had problems.
                        </p>
                        <ul>
                          {healthFailures.map((c) => (
                            <li key={c.id}>
                              {c.label}
                              {c.detail && <div className="bench-check-detail">{c.detail}</div>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {selectedTest.checks.length > 0 && (
                      <div className="bench-checks">
                        <strong>Automated checks</strong>
                        <ul>
                          {[...checkGroups.scores, ...checkGroups.health, ...checkGroups.rest].map(
                            (c) => (
                              <li key={c.id} className={c.passed ? "pass" : "fail"}>
                                {c.passed ? "✓" : "✗"} {c.label}
                                {(c.weight ?? 1) > 1 && (
                                  <span className="bench-check-weight">×{c.weight}</span>
                                )}
                                {!c.passed && c.detail && (
                                  <div className="bench-check-detail">{c.detail}</div>
                                )}
                              </li>
                            ),
                          )}
                        </ul>
                      </div>
                    )}

                    {selectedTest.artifacts.length > 0 && (
                      <div className="bench-artifacts">
                        <strong>Artifacts</strong>
                        <div className="bench-artifact-list">
                          {selectedTest.artifacts.map((path) => (
                            <button
                              key={path}
                              type="button"
                              className={`ghost small ${
                                openArtifact?.name === artifactName(path) ? "active" : ""
                              }`}
                              onClick={() => void showArtifact(path)}
                            >
                              {artifactName(path)}
                            </button>
                          ))}
                        </div>
                        {openArtifact && (
                          <pre className="bench-artifact-view">
                            {openArtifact.content.slice(0, 20000)}
                          </pre>
                        )}
                      </div>
                    )}

                    {selectedTest.metrics && (
                      <div className="bench-metrics muted">
                        {selectedTest.metrics.elapsedMs != null && (
                          <span>{(selectedTest.metrics.elapsedMs / 1000).toFixed(1)}s</span>
                        )}
                        {selectedTest.metrics.tokensPerSecond != null && (
                          <span>{selectedTest.metrics.tokensPerSecond} tok/s</span>
                        )}
                        {selectedTest.metrics.ttftMs != null && (
                          <span>TTFT {selectedTest.metrics.ttftMs}ms</span>
                        )}
                      </div>
                    )}

                    {previewUrl && (
                      <div className="bench-preview">
                        <strong>Preview</strong>
                        <iframe
                          title="Benchmark preview"
                          src={previewUrl}
                          sandbox="allow-scripts allow-same-origin"
                          className="bench-preview-frame"
                        />
                      </div>
                    )}

                    {selectedTest.status === "running" && selectedTest.output && (
                      <div className="bench-live-log">
                        <strong>Live progress</strong>
                        <pre>{selectedTest.output.slice(-8000)}</pre>
                      </div>
                    )}

                    {selectedTest.status !== "running" && selectedTest.output && (
                      <details className="bench-output" open={Boolean(selectedTest.error)}>
                        <summary>Generated output</summary>
                        <pre>{selectedTest.output.slice(0, 12000)}</pre>
                      </details>
                    )}

                    {definitions.find((d) => d.id === selectedTest.testId)?.supportsHumanEval && (
                      <div className="bench-human">
                        <strong>Human evaluation</strong>
                        <div className="bench-human-row">
                          <label>
                            Score (0–{selectedTest.humanMaxScore ?? 10})
                            <input
                              type="number"
                              min={0}
                              max={selectedTest.humanMaxScore ?? 10}
                              value={humanScoreDraft}
                              onChange={(e) => setHumanScoreDraft(e.target.value)}
                            />
                          </label>
                          <label className="bench-human-notes">
                            Notes
                            <input
                              type="text"
                              value={humanNotesDraft}
                              onChange={(e) => setHumanNotesDraft(e.target.value)}
                              placeholder="Optional notes"
                            />
                          </label>
                          <button className="ghost" onClick={() => saveHumanScore()}>
                            Save score
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
          </div>
        )}

        {view === "history" && !selectedRun && (
          <div className="bench-toolbar">
            <button onClick={() => setView("new")}>New benchmark run</button>
          </div>
        )}
      </div>
    </div>
  );
}
