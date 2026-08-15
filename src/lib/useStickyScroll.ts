import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const DEFAULT_THRESHOLD = 80;

type Options = {
  /** Distance from bottom (px) still treated as "following" new content. */
  threshold?: number;
  /** When this changes, scroll pins to bottom again (e.g. new conversation). */
  resetKey?: unknown;
  /** When false, skip follow logic (container not mounted). */
  enabled?: boolean;
};

/**
 * Auto-scroll a container only while the user is near the bottom.
 * Scrolling up disables follow until they return near the bottom or resetKey changes.
 */
export function useStickyScroll(
  containerRef: RefObject<HTMLElement | null>,
  deps: unknown[],
  opts?: Options,
) {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const enabled = opts?.enabled !== false;
  const pinnedRef = useRef(true);

  useEffect(() => {
    pinnedRef.current = true;
  }, [opts?.resetKey]);

  const syncPinned = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, [containerRef, threshold]);

  // Re-bind when content changes — refs often mount only after conditional render.
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;

    const onScroll = () => syncPinned();
    el.addEventListener("scroll", onScroll, { passive: true });
    syncPinned();
    return () => el.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, containerRef, syncPinned, ...deps]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;
    syncPinned();
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, syncPinned, ...deps]);
}
