import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CategoryLibrary, type CategoryLibraryView } from "./categoryLibrary";
import type { EngineClient } from "./client";
import { EngineStore, type EngineView } from "./store";

interface EngineContextValue {
  client: EngineClient;
  store: EngineStore;
  /** CS.3: the window's custom categories and its one paid category call (categoryLibrary.ts). */
  categories: CategoryLibrary;
}

const EngineContext = createContext<EngineContextValue | null>(null);

/** Owns the store for one window: loads the snapshot on mount and catches up when the window comes back. */
export function EngineProvider({ client, children }: { client: EngineClient; children: ReactNode }) {
  const [store] = useState(() => new EngineStore(client));
  const [categories] = useState(() => new CategoryLibrary(client, store));

  useEffect(() => store.start(), [store]);
  useEffect(() => categories.start(), [categories]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        store.reconnect();
        // A disk unplugged or plugged back while the window was away: `export.status` follows checks only, so ask for one.
        void store.recheckExport();
      }
    };
    const onOnline = (): void => store.reconnect();
    // The window coming to the front again (a click back from the file manager). The store throttles the ask.
    const onFocus = (): void => void store.recheckExport();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
    };
  }, [store]);

  const value = useMemo(() => ({ client, store, categories }), [client, store, categories]);
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineContextValue {
  const value = useContext(EngineContext);
  if (!value) throw new Error("useEngine must be used inside <EngineProvider>");
  return value;
}

export function useEngineView(): EngineView {
  const { store } = useEngine();
  return useSyncExternalStore(store.subscribe, store.getView);
}

/** The window's category slice, listed and priced while the calling component is mounted (it retains the slice). */
export function useCategoryLibrary(): { library: CategoryLibrary; view: CategoryLibraryView } {
  const { categories } = useEngine();
  useEffect(() => categories.retain(), [categories]);
  const view = useSyncExternalStore(categories.subscribe, categories.getView);
  return { library: categories, view };
}
