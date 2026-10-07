import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CategoryLibrary, type CategoryLibraryView } from "./categoryLibrary";
import type { EngineClient } from "./client";
import { type SceneSetEntry, SceneSetSlice, type SceneSetSliceView } from "./sceneSetSlice";
import { EngineStore, type EngineView } from "./store";

interface EngineContextValue {
  client: EngineClient;
  store: EngineStore;
  /** CS.3: the window's custom categories and its one paid category call (categoryLibrary.ts). */
  categories: CategoryLibrary;
  /** CS.6: the scene sets the window shows, and what only it knows of their jobs (sceneSetSlice.ts). */
  sceneSets: SceneSetSlice;
}

const EngineContext = createContext<EngineContextValue | null>(null);

/** Owns the store for one window: loads the snapshot on mount and catches up when the window comes back. */
export function EngineProvider({ client, children }: { client: EngineClient; children: ReactNode }) {
  const [store] = useState(() => new EngineStore(client));
  const [categories] = useState(() => new CategoryLibrary(client, store));
  const [sceneSets] = useState(() => new SceneSetSlice(client, store));

  useEffect(() => store.start(), [store]);
  useEffect(() => categories.start(), [categories]);
  useEffect(() => sceneSets.start(), [sceneSets]);

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

  const value = useMemo(() => ({ client, store, categories, sceneSets }), [client, store, categories, sceneSets]);
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

/** An avatar's scene set, read while the calling component is mounted (it retains the avatar in the slice), with the slice's window-only notes. */
export function useSceneSet(avatarId: string): { slice: SceneSetSlice; entry: SceneSetEntry; view: SceneSetSliceView } {
  const { sceneSets } = useEngine();
  useEffect(() => sceneSets.retain(avatarId), [sceneSets, avatarId]);
  const view = useSyncExternalStore(sceneSets.subscribe, sceneSets.getView);
  return { slice: sceneSets, entry: view.sets.get(avatarId) ?? { status: "loading" }, view };
}

/** The window's category slice, listed and priced while the calling component is mounted (it retains the slice). */
export function useCategoryLibrary(): { library: CategoryLibrary; view: CategoryLibraryView } {
  const { categories } = useEngine();
  useEffect(() => categories.retain(), [categories]);
  const view = useSyncExternalStore(categories.subscribe, categories.getView);
  return { library: categories, view };
}
