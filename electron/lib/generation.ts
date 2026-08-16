import type { GenerationState } from "./types";

/**
 * Tracks in-flight chat generation per server so concurrent chats do not clobber
 * Monitor / Server status. Shared by Electron main and the Express backend.
 */
class GenerationTracker {
  private byServer = new Map<string, { state: GenerationState; startMs: number }>();

  start(serverId: string, prompt: string): void {
    const startMs = Date.now();
    this.byServer.set(serverId, {
      startMs,
      state: {
        prompt: prompt.slice(0, 4000),
        stage: "generating",
        startedAt: new Date(startMs).toISOString(),
        finishedAt: null,
        elapsedMs: 0,
        promptTokens: null,
        completionTokens: null,
        tokensPerSecond: null,
        promptTokensPerSecond: null,
        ttftMs: null,
        error: null,
      },
    });
  }

  finish(
    serverId: string,
    metrics?: {
      promptTokens: number | null;
      completionTokens: number | null;
      tokensPerSecond: number | null;
      promptTokensPerSecond: number | null;
      ttftMs: number | null;
    },
  ): void {
    const rec = this.byServer.get(serverId);
    if (!rec) return;
    const elapsedMs = Date.now() - rec.startMs;
    rec.state = {
      ...rec.state,
      stage: "done",
      finishedAt: new Date().toISOString(),
      elapsedMs,
      promptTokens: metrics?.promptTokens ?? null,
      completionTokens: metrics?.completionTokens ?? null,
      tokensPerSecond: metrics?.tokensPerSecond ?? null,
      promptTokensPerSecond: metrics?.promptTokensPerSecond ?? null,
      ttftMs: metrics?.ttftMs ?? null,
    };
  }

  fail(serverId: string, error: string): void {
    const rec = this.byServer.get(serverId);
    if (!rec) return;
    rec.state = {
      ...rec.state,
      stage: "error",
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - rec.startMs,
      error: error.slice(0, 500),
    };
  }

  clear(serverId?: string): void {
    if (serverId) {
      this.byServer.delete(serverId);
      return;
    }
    this.byServer.clear();
  }

  /** Live or most recent generation for one server. */
  current(serverId: string): GenerationState | null {
    const rec = this.byServer.get(serverId);
    if (!rec) return null;
    if (rec.state.stage === "generating") {
      return { ...rec.state, elapsedMs: Date.now() - rec.startMs };
    }
    return rec.state;
  }
}

export const generationTracker = new GenerationTracker();
