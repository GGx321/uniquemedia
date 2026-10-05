import { createContext, useContext, useEffect, useRef } from "react";

export type SectionId = "avatars" | "photo" | "montage" | "autopilot" | "settings";

/**
 * Where the main pane is. `focus` scrolls Settings to the card an error pointed at; `back` is the draft whose editor sent the owner there, for
 * «К черновику» (`arriving` sets it).
 */
export type Route =
  | { name: "avatars"; saved?: string }
  | { name: "avatarNew"; draftId: string | null }
  | { name: "avatarImport" }
  | { name: "settings"; focus?: SettingsFocus; back?: { readonly montageId: string } }
  /** T8b: an avatar's photos; null opens the one shown last, else the first active avatar. `tab` (3e.2): the «Видео» tab, opened from the avatar tile's «K видео». */
  | { name: "photos"; avatarId: string | null; tab?: PhotosTab }
  /** 3d.2: the drafts screen (the sidebar's «Монтаж», EditorEmpty). */
  | { name: "montages" }
  /** 3d.2: one draft in the editor. `created`: opened right after `montages.create`, so the header says «создан только что». */
  | { name: "editor"; montageId: string; created?: boolean }
  | { name: "section"; id: "autopilot" };

export type SettingsFocus = "key" | "money" | "export" | "music";

/** The tabs of an avatar's Photos screen that work (3e.2): «Фото» and «Видео»; «История сцен» is not in Stage 3. */
export type PhotosTab = "photos" | "videos";

export interface NavigateOptions {
  /** Skips the leave guard: the owner chose to leave without saving. */
  readonly force?: boolean;
}

export type Navigate = (route: Route, options?: NavigateOptions) => void;

/**
 * Asked before the window leaves a screen with unsaved work; true lets it go. `target` answers where the owner means
 * to go NOW: clicks while the guard is deciding change it, so a refusal remembers the latest one.
 */
export type LeaveGuard = (target: () => Route) => Promise<boolean>;

export interface Navigation {
  readonly navigate: Navigate;
  /** Guards every way out of the screen (its own buttons and the sidebar alike); returns the function that removes it. */
  readonly guard: (leave: LeaveGuard) => () => void;
}

/**
 * Navigation with one leave guard at a time (3d.2 review, HIGH 1: the editor's unsaved edit must survive every way
 * out). Without a guard a navigation goes at once. With one, the guard is asked and the window goes only if it
 * agrees; clicks while it is still deciding change where the window will go, not the question, so a slow save is
 * waited for once. `force` skips it.
 */
export function createNavigation(go: (route: Route) => void): Navigation {
  let current: LeaveGuard | null = null;
  let asking: { target: Route } | null = null;
  return {
    navigate(route, options) {
      if (current === null || options?.force === true) {
        asking = null;
        go(route);
        return;
      }
      if (asking !== null) {
        asking.target = route;
        return;
      }
      const ask = { target: route };
      asking = ask;
      void current(() => ask.target).then(
        (ok) => {
          if (asking !== ask) return;
          asking = null;
          if (ok) go(ask.target);
        },
        () => {
          // A guard that throws keeps the window where it is: its screen says why.
          if (asking === ask) asking = null;
        },
      );
    },
    guard(leave) {
      current = leave;
      return () => {
        if (current === leave) current = null;
      };
    },
  };
}

const NavigationContext = createContext<Navigation | null>(null);

export const NavigationProvider = NavigationContext.Provider;

function useNavigation(): Navigation {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error("useNavigate must be used inside <NavigationProvider>");
  return navigation;
}

export function useNavigate(): Navigate {
  return useNavigation().navigate;
}

/** Guards every way out of the calling screen while it is mounted; the newest `guard` is the one asked. */
export function useLeaveGuard(guard: LeaveGuard): void {
  const { guard: register } = useNavigation();
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => register((target) => latest.current(target)), [register]);
}

/**
 * Where the window goes from `from` when asked for `to` (slice review 5-M2): Settings entered from a draft's editor, by any way (its links to the
 * trending list, the export folder or an error's card, or the sidebar), remembers the draft for «К черновику»; a link to another of Settings' own
 * cards keeps it. Every other route is the one asked for.
 */
export function arriving(from: Route, to: Route): Route {
  if (to.name !== "settings" || to.back !== undefined) return to;
  if (from.name === "editor") return { ...to, back: { montageId: from.montageId } };
  if (from.name === "settings" && from.back !== undefined) return { ...to, back: from.back };
  return to;
}

export function sectionOf(route: Route): SectionId {
  switch (route.name) {
    case "avatars":
    case "avatarNew":
    case "avatarImport":
      return "avatars";
    case "settings":
      return "settings";
    case "photos":
      return "photo";
    case "montages":
    case "editor":
      return "montage";
    case "section":
      return route.id;
  }
}
