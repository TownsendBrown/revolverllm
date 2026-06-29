import type { GenerationState } from "./types";

/**
 * Tracks the in-flight (and most recently completed) chat generation so the UI
 * can show what prompt is being processed and at what stage. Shared by the
 * Electron main process and the Docker HTTP backend chat handlers.
 */
class GenerationTracker {
  private state: GenerationState | null = null;
  private startMs = 0;

  start(prompt: string): void {
    this.startMs = Date.now();
    this.state = {
      prompt: prompt.slice(0, 4000),
      stage: "generating",
      startedAt: new Date(this.startMs).toISOString(),
      finishedAt: null,
      elapsedMs: 0,
      promptTokens: null,
      completionTokens: null,
      tokensPerSecond: null,
      promptTokensPerSecond: null,
      ttftMs: null,
      error: null,
    };
  }

  finish(metrics?: {
    promptTokens: number | null;
    completionTokens: number | null;
    tokensPerSecond: number | null;
    promptTokensPerSecond: number | null;
    ttftMs: number | null;
  }): void {
    if (!this.state) return;
    const elapsedMs = Date.now() - this.startMs;
    this.state = {
      ...this.state,
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

  fail(error: string): void {
    if (!this.state) return;
    this.state = {
      ...this.state,
      stage: "error",
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - this.startMs,
      error: error.slice(0, 500),
    };
  }

  clear(): void {
    this.state = null;
  }

  get current(): GenerationState | null {
    if (!this.state) return null;
    if (this.state.stage === "generating") {
      return { ...this.state, elapsedMs: Date.now() - this.startMs };
    }
    return this.state;
  }
}

export const generationTracker = new GenerationTracker();
