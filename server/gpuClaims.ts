import type { GpuMode, InferenceBackend, ServerDefinition } from "../shared/types";

export interface GpuOccupant {
  serverId: string;
  name: string;
  backend: InferenceBackend;
  gpuDevices: number[];
  gpuMode: GpuMode;
}

const claims = new Map<string, GpuOccupant>();

function claimKey(backend: InferenceBackend, device: number): string {
  return `${backend}:${device}`;
}

function occupantDevices(occ: GpuOccupant): number[] {
  if (occ.gpuMode === "single" && occ.gpuDevices.length > 1) return [occ.gpuDevices[0]];
  return occ.gpuDevices;
}

function overlappingDevices(incoming: GpuOccupant, occupied: GpuOccupant): number[] {
  if (incoming.backend !== occupied.backend) return [];
  const have = new Set(occupantDevices(occupied));
  return occupantDevices(incoming).filter((d) => have.has(d));
}

export function resetGpuClaims(): void {
  claims.clear();
}

export function listGpuClaims(): GpuOccupant[] {
  return [...claims.values()];
}

export function gpuClaimConflict(
  incoming: Pick<ServerDefinition, "id" | "name" | "backend" | "gpuDevices" | "gpuMode">,
  occupied: GpuOccupant[],
): string | null {
  if (incoming.backend === "cpu" || incoming.backend === "metal") return null;
  if (!incoming.gpuDevices.length) return null;
  const self: GpuOccupant = {
    serverId: incoming.id,
    name: incoming.name,
    backend: incoming.backend,
    gpuDevices: incoming.gpuDevices,
    gpuMode: incoming.gpuMode,
  };
  for (const other of occupied) {
    if (other.serverId === incoming.id) continue;
    const overlap = overlappingDevices(self, other);
    if (!overlap.length) continue;
    return `GPU ${overlap.join(",")} (${incoming.backend}) claimed by server "${other.name}" (${other.serverId})`;
  }
  return null;
}

/**
 * Exclusive lease for backend-native GPU indices.
 * `force` records the claim anyway so occupancy stays accurate when sharing.
 */
export function claimGpus(
  def: Pick<ServerDefinition, "id" | "name" | "backend" | "gpuDevices" | "gpuMode">,
  opts?: { force?: boolean },
): void {
  const others = [...claims.values()];
  const conflict = gpuClaimConflict(def, others);
  if (conflict && !opts?.force) throw new Error(conflict);
  claims.set(def.id, {
    serverId: def.id,
    name: def.name,
    backend: def.backend,
    gpuDevices: def.gpuDevices,
    gpuMode: def.gpuMode,
  });
}

export function releaseGpus(serverId: string): void {
  claims.delete(serverId);
}

export function claimedKeys(): string[] {
  const keys: string[] = [];
  for (const occ of claims.values()) {
    for (const d of occupantDevices(occ)) keys.push(claimKey(occ.backend, d));
  }
  return keys;
}
