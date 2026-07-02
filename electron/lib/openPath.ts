import { existsSync, statSync } from "fs";
import { shell } from "electron";

/** Open via Electron shell APIs (Finder / default file manager). Empty string = success. */
export async function openPathElectron(hostPath: string): Promise<string> {
  if (!existsSync(hostPath)) return "Path not found";

  if (statSync(hostPath).isDirectory()) {
    return shell.openPath(hostPath);
  }

  shell.showItemInFolder(hostPath);
  return "";
}
