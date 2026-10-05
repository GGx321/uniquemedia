import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { flush } from "../testing";
import { type ManualFrames, manualFrames } from "./montage/frames.testkit";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import { photoClip } from "./montage/testkit";

// The owner's feedback (2026-10-05): Space plays and pauses the montage. Not while typing; on a focused button it plays INSTEAD of pressing the
// button (no double action: the timeline's own ▶ would otherwise start and stop at once); inside an open dialog or menu Space keeps its meaning.
// The play controls say «Пробел».

const [P1, P2] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""];
const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const preview = (): HTMLElement => screen.getByRole("region", { name: "Превью" });
const playing = (): boolean => within(timeline()).queryByRole("button", { name: "Пауза" }) !== null;
const clockText = (): string => (timeline().querySelector(".ed-tl-clock")?.textContent ?? "").replace(/\s+/g, " ");

let frames: ManualFrames | null = null;
const cleanup: (() => void)[] = [];
afterEach(() => {
  frames?.restore();
  frames = null;
  for (const undo of cleanup.splice(0)) undo();
});

async function openDraft(engine: MockEngine, client: Parameters<typeof makeDraft>[0], patch: Partial<MontageDraft> = {}): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: [P1, P2].map((photoId, i) => photoClip(i, photoId, 2_000)), ...patch };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

async function editor(patch: Partial<MontageDraft> = {}): Promise<void> {
  frames = manualFrames();
  const { client, engine } = await studio();
  await openDraft(engine, client, patch);
}

/**
 * Space pressed and let go on `target` as a browser does it: the key goes down, then up, and a FOCUSED BUTTON is pressed on the way up unless
 * one of the two was taken (`preventDefault`). Answers whether each was left to the control.
 */
function pressSpace(target: Element, over: { repeat?: boolean } = {}): { down: boolean; up: boolean } {
  const down = fireEvent.keyDown(target, { key: " ", code: "Space", ...over });
  const up = fireEvent.keyUp(target, { key: " ", code: "Space" });
  if (down && up && target instanceof HTMLButtonElement) fireEvent.click(target, { detail: 0 });
  return { down, up };
}

describe("Space plays and pauses the montage", () => {
  test("with nothing focused: plays, and pauses again", async () => {
    await editor();
    expect(pressSpace(document.body)).toEqual({ down: false, up: false });
    expect(playing()).toBe(true);
    frames?.advance(500);
    expect(clockText()).toBe("00:00.5 / 00:04.0");
    pressSpace(document.body);
    expect(playing()).toBe(false);
  });

  test("on the focused ▶ of the timeline: once, the button is not also pressed (no start-and-stop)", async () => {
    await editor();
    const play = within(timeline()).getByRole("button", { name: "Воспроизвести" });
    play.focus();
    expect(pressSpace(play)).toEqual({ down: false, up: false });
    expect(playing()).toBe(true);
  });

  test("on another focused button (the «Зоны Reels» switch): plays, and the switch stays as it was", async () => {
    await editor();
    const zones = within(preview()).getByRole("switch", { name: "Зоны Reels" });
    zones.focus();
    pressSpace(zones);
    expect(playing()).toBe(true);
    expect(zones.getAttribute("aria-checked")).toBe("true");
    // Enter still presses it.
    fireEvent.click(zones);
    expect(zones.getAttribute("aria-checked")).toBe("false");
  });

  test("a held Space (the key repeating) does not toggle again", async () => {
    await editor();
    pressSpace(document.body);
    expect(pressSpace(document.body, { repeat: true }).down).toBe(false);
    expect(playing()).toBe(true);
  });

  test("not while typing: the draft's name field keeps its space", async () => {
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    const field = screen.getByRole("textbox", { name: "Название черновика" });
    expect(pressSpace(field)).toEqual({ down: true, up: true });
    expect(playing()).toBe(false);
  });

  test("not inside an open dialog: its focused button is pressed as usual", async () => {
    await editor();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const button = document.createElement("button");
    let pressed = 0;
    button.addEventListener("click", () => {
      pressed += 1;
    });
    dialog.append(button);
    document.body.append(dialog);
    cleanup.push(() => dialog.remove());
    button.focus();
    expect(pressSpace(button)).toEqual({ down: true, up: true });
    expect(pressed).toBe(1);
    expect(playing()).toBe(false);
    // With the modal open the editor behind it takes no Space at all.
    expect(pressSpace(document.body).down).toBe(true);
    expect(playing()).toBe(false);
  });

  test("an empty montage has nothing to play: Space is left alone", async () => {
    await editor({ clips: [] });
    expect(pressSpace(document.body)).toEqual({ down: true, up: true });
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" }).hasAttribute("disabled")).toBe(true);
  });

  test("the play controls say so: «Пробел» in their tips and their key shortcut", async () => {
    await editor();
    for (const button of [within(timeline()).getByRole("button", { name: "Воспроизвести" }), within(preview()).getByRole("button", { name: "Воспроизвести" })]) {
      expect(button.getAttribute("aria-keyshortcuts")).toBe("Space");
      expect(button.getAttribute("title")).toBe("Воспроизвести · Пробел");
    }
    pressSpace(document.body);
    expect(within(timeline()).getByRole("button", { name: "Пауза" }).getAttribute("title")).toBe("Пауза · Пробел");
  });
});
