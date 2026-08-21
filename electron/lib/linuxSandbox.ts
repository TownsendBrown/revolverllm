/** Chromium aborts if chrome-sandbox exists without root setuid. */
export function chromeSandboxNeedsNoSandbox(mode: number, uid: number): boolean {
  const setuid = (mode & 0o4000) !== 0;
  return !(setuid && uid === 0);
}

/**
 * Electron 34 on Wayland (NVIDIA especially) paints a blank window.
 * Force X11/XWayland unless the user already set ELECTRON_OZONE_PLATFORM_HINT.
 */
export function linuxOzonePlatformHint(env: NodeJS.ProcessEnv = process.env): "x11" | null {
  const override = env.ELECTRON_OZONE_PLATFORM_HINT?.trim();
  if (override) return null;
  return "x11";
}
