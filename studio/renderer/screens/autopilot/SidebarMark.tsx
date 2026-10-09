import { useEffect, useState } from "react";
import { useEngineView } from "../../engine/react";
import { sidebarMark, type SidebarMark } from "./planModel";

// S4.9a: the mark at «Автопилот» in the sidebar (the design's decision 12; HostStates «Боковая панель»): «14 / 30» while the launch runs, «сцены», «пауза»,
// «ждёт», «готово» — seen from any screen. It is described with the item (aria-describedby), never part of its name, so «Автопилот» stays «Автопилот».

/**
 * The mark of the window's launch. «готово» stays until the owner has had the screen open with the launch done (`onScreen`): the window remembers that
 * launch as seen for as long as it runs.
 */
export function useSidebarMark(onScreen: boolean): SidebarMark | null {
  const launch = useEngineView().autopilot;
  const [seen, setSeen] = useState<string | null>(null);
  const endedId = launch !== null && launch.status === "done" ? launch.launchId : null;
  useEffect(() => {
    if (onScreen && endedId !== null) setSeen(endedId);
  }, [onScreen, endedId]);
  if (onScreen && endedId !== null) return null;
  return sidebarMark(launch, seen);
}

/**
 * The visible mark: a dot in its colour and the word, hidden from a screen reader, which hears `descriptionId` instead. That one is `hidden` too: inside
 * the item's button any text it shows would join the item's name, while a hidden element named by aria-describedby is still read as its description.
 */
export function SidebarMarkView({ mark, descriptionId }: { mark: SidebarMark; descriptionId: string }) {
  return (
    <>
      <span className={`ap-side-mark ap-side-${mark.tone}`} aria-hidden="true">
        <span className="ap-side-dot" />
        {mark.text}
      </span>
      <span id={descriptionId} hidden>
        {mark.description}
      </span>
    </>
  );
}
