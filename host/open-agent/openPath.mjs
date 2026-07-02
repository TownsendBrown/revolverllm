import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** @returns {Promise<string>} empty string = success */
export async function openPathOnHost(hostPath) {
  if (!existsSync(hostPath)) return "Path not found";

  const isDir = statSync(hostPath).isDirectory();
  const platform = process.platform;

  try {
    if (platform === "darwin") {
      await execFileAsync("open", isDir ? [hostPath] : ["-R", hostPath]);
      return "";
    }
    if (platform === "linux") {
      await execFileAsync("xdg-open", [hostPath]);
      return "";
    }
    if (platform === "win32") {
      await execFileAsync("explorer", [isDir ? hostPath : `/select,${hostPath}`]);
      return "";
    }
    return `Unsupported platform: ${platform}`;
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") {
      return platform === "linux"
        ? "xdg-open not found (install xdg-utils)"
        : "System open utility not found";
    }
    return err.message ?? String(e);
  }
}
