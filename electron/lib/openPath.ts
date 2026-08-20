import { openPathOnHost } from "../../shared/openPath";

/** Open in Finder / file manager. Uses `open` on macOS — shell.openPath returns "Invalid path". */
export async function openPathElectron(hostPath: string): Promise<string> {
  return openPathOnHost(hostPath);
}
