import type { HubFormatFilter } from "../shared/types";
import { mergeWithCompanions } from "../shared/hubDownloadFiles";
import { getHfToken } from "../electron/lib/secrets";

const REPO_ID = /^[\w.-]+\/[\w.-]+$/;

export function assertRepoId(repoId: string): void {
  if (!REPO_ID.test(repoId)) throw new Error("Invalid repo id (expected org/model)");
}

function hfHeaders(): Record<string, string> {
  const token = getHfToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface HubSearchResult {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  lastModified: string | null;
  sizeBytes: number | null;
  tags: string[];
  pipeline_tag: string | null;
  gated: boolean;
}

export type HubSearchSort = "downloads" | "likes" | "lastModified" | "trendingScore";

const HUB_SORTS = new Set<HubSearchSort>(["downloads", "likes", "lastModified", "trendingScore"]);

function normalizeSort(sort?: string): HubSearchSort {
  if (sort && HUB_SORTS.has(sort as HubSearchSort)) return sort as HubSearchSort;
  return "downloads";
}

function sizeFromRow(row: {
  gguf?: { totalFileSize?: number; total?: number } | null;
  safetensors?: { total?: number } | null;
}): number | null {
  const gguf = row.gguf;
  if (gguf) {
    const n = gguf.totalFileSize ?? gguf.total;
    if (n != null && n > 0) return n;
  }
  const st = row.safetensors?.total;
  if (st != null && st > 0) return st;
  return null;
}

export async function searchModels(opts: {
  query: string;
  filter?: HubFormatFilter;
  sort?: HubSearchSort | string;
  limit?: number;
}): Promise<HubSearchResult[]> {
  const q = opts.query.trim();
  const limit = opts.limit ?? 25;
  const filter = opts.filter ?? "all";
  const sort = normalizeSort(opts.sort);

  const url = new URL("https://huggingface.co/api/models");
  if (q) {
    let search = q;
    if (filter === "gguf") search = `${q} gguf`;
    else if (filter === "safetensors") search = `${q} safetensors`;
    else if (filter === "mlx") search = `${q} mlx`;
    url.searchParams.set("search", search);
  }
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sort", sort);
  url.searchParams.set("direction", "-1");
  if (filter === "gguf") url.searchParams.set("filter", "gguf");
  else if (filter === "safetensors") url.searchParams.set("filter", "safetensors");
  else if (filter === "mlx") url.searchParams.set("filter", "mlx");

  for (const field of [
    "downloads",
    "likes",
    "lastModified",
    "gated",
    "pipeline_tag",
    "tags",
    "author",
    "gguf",
    "safetensors",
  ]) {
    url.searchParams.append("expand", field);
  }

  const res = await fetch(url.toString(), { headers: hfHeaders() });
  if (!res.ok) {
    throw new Error(`Hub search failed: ${res.status}`);
  }
  const rows = (await res.json()) as Array<{
    id?: string;
    author?: string;
    downloads?: number;
    likes?: number;
    lastModified?: string;
    tags?: string[];
    pipeline_tag?: string | null;
    gated?: boolean | string;
    gguf?: { totalFileSize?: number; total?: number } | null;
    safetensors?: { total?: number } | null;
  }>;

  return rows
    .filter((r) => r.id)
    .map((r) => ({
      id: r.id!,
      author: r.author ?? r.id!.split("/")[0] ?? "",
      downloads: r.downloads ?? 0,
      likes: r.likes ?? 0,
      lastModified: r.lastModified ?? null,
      sizeBytes: sizeFromRow(r),
      tags: r.tags ?? [],
      pipeline_tag: r.pipeline_tag ?? null,
      gated: r.gated === true || r.gated === "auto" || r.gated === "manual",
    }))
    .filter((r) => {
      if (filter === "all") return true;
      const tagStr = `${r.id} ${r.tags.join(" ")}`.toLowerCase();
      if (filter === "gguf") return tagStr.includes("gguf") || r.tags.some((t) => t.toLowerCase().includes("gguf"));
      if (filter === "mlx") {
        return (
          tagStr.includes("mlx") ||
          r.tags.some((t) => /mlx|mlx-lm/i.test(t))
        );
      }
      return (
        tagStr.includes("safetensors") ||
        r.pipeline_tag === "text-generation" ||
        r.tags.some((t) => /safetensors|pytorch|transformers/i.test(t))
      );
    });
}

export interface HubFileEntry {
  path: string;
  size: number | null;
  oid: string;
}

function hubRepoApiPath(repoId: string): string {
  assertRepoId(repoId);
  const slash = repoId.indexOf("/");
  const org = repoId.slice(0, slash);
  const model = repoId.slice(slash + 1);
  return `${encodeURIComponent(org)}/${encodeURIComponent(model)}`;
}

export async function listRepoFiles(repoId: string, revision = "main"): Promise<HubFileEntry[]> {
  const url = `https://huggingface.co/api/models/${hubRepoApiPath(repoId)}/tree/${encodeURIComponent(revision)}?recursive=true`;
  const res = await fetch(url, { headers: hfHeaders() });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Gated model — accept the license on huggingface.co and set your HF token in Models");
  }
  if (!res.ok) throw new Error(`Hub list files failed: ${res.status}`);
  const rows = (await res.json()) as Array<{ path?: string; size?: number; oid?: string; type?: string }>;
  const out: HubFileEntry[] = [];
  for (const row of rows) {
    if (!row.path || row.type === "directory") continue;
    out.push({
      path: row.path,
      size: row.size ?? null,
      oid: row.oid ?? "",
    });
  }
  return out;
}

export async function probeRepoSize(repoId: string, revision: string, files: string[] | null): Promise<number | null> {
  const entries = await listRepoFiles(repoId, revision);
  const paths = entries.map((e) => e.path);
  const wanted = new Set(
    files?.length
      ? mergeWithCompanions(
          paths,
          entries
            .filter((e) => files.some((f) => e.path === f || e.path.endsWith(`/${f}`)))
            .map((e) => e.path),
        )
      : entries
          .filter((e) => e.path.endsWith(".gguf") || e.path.endsWith(".safetensors") || e.path === "config.json")
          .map((e) => e.path),
  );
  const picked = entries.filter((e) => wanted.has(e.path));
  const sizes = picked.map((e) => e.size).filter((s): s is number => s != null && s > 0);
  if (!sizes.length) return null;
  return sizes.reduce((a, b) => a + b, 0);
}

export async function downloadFile(opts: {
  repoId: string;
  revision: string;
  path: string;
  destPath: string;
  signal?: AbortSignal;
  onProgress?: (bytes: number) => void;
}): Promise<void> {
  assertRepoId(opts.repoId);
  const url = `https://huggingface.co/${opts.repoId}/resolve/${encodeURIComponent(opts.revision)}/${opts.path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url, { headers: hfHeaders(), signal: opts.signal, redirect: "follow" });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Gated model — accept the license on huggingface.co and set your HF token in Models");
  }
  if (!res.ok) throw new Error(`Download failed ${opts.path}: ${res.status}`);
  if (!res.body) throw new Error("Empty response body");

  const { createWriteStream, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  const { pipeline } = await import("stream/promises");
  const { Readable } = await import("stream");
  mkdirSync(dirname(opts.destPath), { recursive: true });
  const ws = createWriteStream(opts.destPath);
  let done = 0;
  const reader = res.body.getReader();
  const nodeStream = new Readable({
    async read() {
      try {
        const { done: d, value } = await reader.read();
        if (d) {
          this.push(null);
          return;
        }
        done += value.byteLength;
        opts.onProgress?.(done);
        this.push(Buffer.from(value));
      } catch (e) {
        this.destroy(e as Error);
      }
    },
  });
  await pipeline(nodeStream, ws);
}
