export type HostAgentRequest =
  | { id: string; method: "ping" }
  | { id: string; method: "ensure"; params: { serverId: string; hostPort: number } }
  | { id: string; method: "restart"; params: { serverId: string; hostPort: number } }
  | { id: string; method: "stop"; params: { serverId: string } }
  | { id: string; method: "inspect"; params: { serverId: string } }
  | { id: string; method: "logs"; params: { serverId: string; tail?: number; since?: string | null } }
  | { id: string; method: "list" }
  | { id: string; method: "monitor" };

export type HostAgentResponse =
  | { id: string; result: unknown }
  | { id: string; error: string };

export interface ServerInspect {
  serverId: string;
  hostPort: number;
  status: "idle" | "starting" | "running" | "stopped" | "crashed";
  pid: number | null;
  startedAt: string | null;
}
