import { createContext, useContext } from "react";

export type SectionId = "avatars" | "photo" | "montage" | "autopilot" | "settings";

/** Where the main pane is. `focus` scrolls Settings to the card an error pointed at. */
export type Route =
  | { name: "avatars"; saved?: string }
  | { name: "avatarNew"; draftId: string | null }
  | { name: "avatarImport" }
  | { name: "settings"; focus?: SettingsFocus }
  /** T8b: an avatar's photos; null opens the one shown last, else the first active avatar. */
  | { name: "photos"; avatarId: string | null }
  /** 3d.2: the drafts screen (the sidebar's «Монтаж», EditorEmpty). */
  | { name: "montages" }
  /** 3d.2: one draft in the editor. `created`: opened right after `montages.create`, so the header says «создан только что». */
  | { name: "editor"; montageId: string; created?: boolean }
  | { name: "section"; id: "autopilot" };

export type SettingsFocus = "key" | "money";

export type Navigate = (route: Route) => void;

const NavigationContext = createContext<Navigate | null>(null);

export const NavigationProvider = NavigationContext.Provider;

export function useNavigate(): Navigate {
  const navigate = useContext(NavigationContext);
  if (!navigate) throw new Error("useNavigate must be used inside <NavigationProvider>");
  return navigate;
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
