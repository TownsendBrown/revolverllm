/** Chromium aborts if chrome-sandbox exists without root setuid. */
export function chromeSandboxNeedsNoSandbox(mode: number, uid: number): boolean {
  const setuid = (mode & 0o4000) !== 0;
  return !(setuid && uid === 0);
}
