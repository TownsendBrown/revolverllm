import { openPathOnHost } from "../../../shared/openPath.js";

export function openHostPath(path: string): Promise<string> {
  return openPathOnHost(path);
}
