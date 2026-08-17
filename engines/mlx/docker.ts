/** revolver_mlx_server listens on this port; native spawn overrides with hostPort. */
export const MLX_CONTAINER_PORT = 8080;

export const MLX_ENTRYPOINT_FILE = "mlx-entrypoint.sh";

export function mlxEnvFileName(serverId: string): string {
  return `mlx-load-${serverId}.env`;
}

/** Native-only engine — Docker cannot reach Metal. Stub keeps InferenceEngine intact. */
export const MLX_ENTRYPOINT_SCRIPT = `#!/bin/sh
echo "MLX cannot run in Docker on macOS (no Metal GPU). Use native runtime." >&2
exit 1
`;
