import { loadServerConfig } from "./serverConfig";

export class ServerLogBuffer {
  private lines: string[] = [];
  private limit = 500;

  setLimit(n: number): void {
    this.limit = Math.max(50, n);
    this.trim();
  }

  append(chunk: string): void {
    const parts = chunk.split("\n").filter((l) => l.length > 0);
    this.lines.push(...parts);
    this.trim();
  }

  clear(): void {
    this.lines = [];
  }

  getLines(): string[] {
    return [...this.lines];
  }

  private trim(): void {
    if (this.lines.length > this.limit) {
      this.lines = this.lines.slice(-this.limit);
    }
  }
}

export const serverLogs = new ServerLogBuffer();

export function initLogLimit(): void {
  serverLogs.setLimit(loadServerConfig().logLinesLimit);
}
