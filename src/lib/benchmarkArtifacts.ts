/** Build preview URL for benchmark HTML artifacts (web/docker UI). */
export function benchmarkArtifactUrl(runId: string, testId: string, filename: string): string {
  return `/api/benchmarks/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(testId)}/${encodeURIComponent(filename)}`;
}

export function isElectron(): boolean {
  return typeof window !== "undefined" && Boolean(window.revolver);
}

/** Load HTML artifact as blob URL (Electron) or direct URL (web). Caller must revoke blob URLs. */
export async function loadHtmlPreview(
  runId: string,
  testId: string,
  readArtifact: (runId: string, testId: string, filename: string) => Promise<string>,
): Promise<string> {
  if (!isElectron()) {
    return benchmarkArtifactUrl(runId, testId, "index.html");
  }
  const html = await readArtifact(runId, testId, "index.html");
  const blob = new Blob([html], { type: "text/html" });
  return URL.createObjectURL(blob);
}
