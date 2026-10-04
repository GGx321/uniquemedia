import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { flush } from "../testing";
import { type ManualFrames, manualFrames } from "./montage/frames.testkit";
import * as renderBlockModule from "./montage/renderBlock";
import { makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import * as scaleModule from "./montage/timelineScale";

// 3d.4: the editor's live preview. The playhead is the preview's clock and lives in a store of its own, so a playback re-renders
// only what follows it (the 3d.3a / 3d.3b note: it lived in the editor's state, and every frame re-rendered the whole editor).

const [P1, P2] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""];

const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const clockText = (): string => (timeline().querySelector(".ed-tl-clock")?.textContent ?? "").replace(/\s+/g, " ");

async function openEditor(): Promise<void> {
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

let frames: ManualFrames | null = null;
const restores: (() => void)[] = [];
afterEach(() => {
  frames?.restore();
  frames = null;
  for (const restore of restores.splice(0)) restore();
});

describe("playback", () => {
  test("a playback re-renders neither the editor nor the timeline's tracks: the clock and the playhead follow it on their own", async () => {
    frames = manualFrames();
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1, P2]);
    await openEditor();
    // `renderBlock` runs once per render of the editor, `rulerMarks` once per render of the timeline.
    const editorRenders = spyOn(renderBlockModule, "renderBlock");
    const timelineRenders = spyOn(scaleModule, "rulerMarks");
    restores.push(() => editorRenders.mockRestore(), () => timelineRenders.mockRestore());

    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    for (let i = 0; i < 30; i++) frames.advance(34);
    expect(clockText()).toBe("00:01.0 / 00:08.0");
    expect(within(timeline()).getByRole("slider", { name: "Плейхед" }).getAttribute("aria-valuenow")).toBe("1000");
    expect(editorRenders).toHaveBeenCalledTimes(0);
    expect(timelineRenders).toHaveBeenCalledTimes(0);

    // A pause rests the playhead: the toolbar and the panels now act at 1.0 s, still without the editor re-rendering.
    fireEvent.click(within(timeline()).getByRole("button", { name: "Пауза" }));
    expect(clockText()).toBe("00:01.0 / 00:08.0");
    expect(timelineRenders.mock.calls.length).toBeGreaterThan(0);
    expect(editorRenders).toHaveBeenCalledTimes(0);
  });

  test("the playback runs to the end of the montage and stops there", async () => {
    frames = manualFrames();
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    frames.advance(5_000);
    expect(clockText()).toBe("00:05.0 / 00:08.0");
    frames.advance(5_000);
    expect(clockText()).toBe("00:08.0 / 00:08.0");
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" })).toBeDefined();
    expect(frames.pending()).toBe(0);
  });
});
