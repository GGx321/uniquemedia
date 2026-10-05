import { useSyncExternalStore } from "react";

// `window.devicePixelRatio`, followed when the window moves to a screen of another ratio (or the page is zoomed). One media query
// serves every subscriber (a gallery holds hundreds of portraits): it matches the ratio as it is now and stops matching when the
// ratio moves, and is then replaced by one for the new ratio.

const listeners = new Set<() => void>();
let query: MediaQueryList | null = null;

function current(): number {
  return window.devicePixelRatio || 1;
}

function onChange(): void {
  watch();
  for (const listener of listeners) listener();
}

function watch(): void {
  query?.removeEventListener("change", onChange);
  query = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${current()}dppx)`) : null;
  query?.addEventListener("change", onChange);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    query?.removeEventListener("change", onChange);
    query = null;
  };
}

/** Listens to nothing: a component that does not depend on the ratio yet reads it on its own renders only. */
function ignore(): () => void {
  return () => {};
}

/**
 * The screen's pixel ratio: how many screen pixels one CSS pixel takes (2 on a Retina screen). Followed only while `watching`
 * (a portrait whose picture has loaded): a placeholder, or a picture still on its way, keeps no query open.
 */
export function useDevicePixelRatio(watching = true): number {
  return useSyncExternalStore(watching ? subscribe : ignore, current);
}
