import { expect } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CommandPayload, CommandType, MontageDraft } from "../../../shared/engine";
import { App } from "../../App";
import type { EngineClient, EngineReply } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { freePhotos, PHOTO_IDS } from "../../engine/mockEngine.testkit";
import { ManualScheduler } from "../../engine/scheduler";
import { callsOf, flush } from "../../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, withCounts } from "./screenKit";
import { photoClip } from "./testkit";

// Test support for the «Мои» tab's screen tests (3f.6): the App on the mock with a client the test may wrap (a drop door, a held listing, the
// real client's kind), the library a test seeds, a draft opened on «Мои». Test-only.

export const IDS = PHOTO_IDS.slice(0, 4);
export const PHOTO = "media-demo-0001";
export const VIDEO = "media-demo-0002";
export const SONG = "media-demo-0003";
export const NOTE = "media-demo-0004";
export const STICKER = "media-demo-0005";
export const BLINK = "media-demo-0006";

/** A photo, a 6.4 s video, a 42 s and a 5 s track (shorter than the 8 s montage), a sticker, and a video of 0.4 s; listed newest first. */
export function seedMine(engine: MockEngine): void {
  engine.seedOwnMedia([
    { kind: "photo", name: "croissant.jpg", bytes: 900_000, createdAt: "2026-10-01T10:00:00.000Z" },
    { kind: "video", name: "latte-pour.mov", bytes: 40_000_000, facts: { width: 1080, height: 1920, durationMs: 6_400, sourceFps: 60, hdrToSdr: true }, createdAt: "2026-10-01T10:01:00.000Z" },
    { kind: "audio", name: "summer-edit.mp3", bytes: 1_000_000, facts: { durationMs: 42_000 }, createdAt: "2026-10-01T10:02:00.000Z" },
    { kind: "audio", name: "voice-note.m4a", bytes: 90_000, facts: { durationMs: 5_000 }, createdAt: "2026-10-01T10:03:00.000Z" },
    { kind: "sticker", name: "underline.gif", bytes: 40_000, createdAt: "2026-10-01T10:04:00.000Z" },
    { kind: "video", name: "blink.mov", bytes: 300_000, facts: { width: 1080, height: 1920, durationMs: 400, sourceFps: 30 }, createdAt: "2026-10-01T10:05:00.000Z" },
  ]);
}

/** The App on a mock on a manual clock, with Mia and six free photos; `wrap` gives the App another client over the mock's. */
export async function mineStudio(wrap?: (client: EngineClient, engine: MockEngine) => EngineClient) {
  const photos = freePhotos(6);
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, latencyMs: 0, avatars: [withCounts(MIA, photos)], photos });
  const base = mockEngineClient(engine);
  const client = wrap === undefined ? base : wrap(base, engine);
  const utils = render(<App client={client} />);
  await screen.findByRole("heading", { level: 2, name: MIA.name });
  return { engine, scheduler, client, ...utils };
}

export const media = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
export const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
export const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
export const preview = (): HTMLElement => screen.getByRole("region", { name: "Превью" });
export const section = (name: string): HTMLElement => within(media()).getByRole("region", { name });
export const dropZone = (): HTMLElement => within(media()).getByRole("button", { name: /^(Добавить файлы|Отпустите)/ });
export const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");

/** A draft of four 2 s photo clips (8.0 s) with `patch`, saved as another window would; opened, on «Мои». */
export async function openMine(engine: MockEngine, client: EngineClient, patch: Partial<MontageDraft> = {}): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: IDS.map((photoId, i) => photoClip(i, photoId, 2_000)), ...patch };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  for (let i = engine.calls.length - 1; i >= 0; i--) if (engine.calls[i]?.type === "montages.save") engine.calls.splice(i, 1);
  fireEvent.click(within(media()).getByRole("tab", { name: "Мои" }));
  await flush();
}

export async function nextSave(engine: MockEngine): Promise<MontageDraft> {
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(0), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  const last = callsOf(engine, "montages.save").at(-1);
  if (last === undefined) throw new Error("no save");
  return last.payload.spec;
}

/** The tab's own listings (`media.list {}`, no kind and no ids) the mock was sent. */
export const tabListings = (engine: MockEngine): number => callsOf(engine, "media.list").filter((c) => c.payload.kind === undefined && c.payload.mediaIds === undefined).length;

/**
 * A client whose tab listings (`media.list {}`) are answered as the engine holds the library WHEN ASKED, but handed back only when the test lets
 * them go, in the order it chooses: a listing that left before a change and lands after it.
 */
export function heldListings(base: EngineClient) {
  const held: (() => void)[] = [];
  let holding = false;
  const request = <T extends CommandType>(type: T, payload: CommandPayload<T>): Promise<EngineReply<T>> => {
    const answer = base.request(type, payload);
    if (!holding || type !== "media.list" || Object.keys(payload).length > 0) return answer;
    return new Promise<EngineReply<T>>((resolve) => held.push(() => void answer.then(resolve)));
  };
  const client: EngineClient = { ...base, request };
  return {
    client,
    hold(on: boolean): void {
      holding = on;
    },
    /** How many listings were held so far. */
    waiting: (): number => held.length,
    /** Lets the listing at `index` (0 = the first held) go. */
    release(index: number): void {
      const go = held[index];
      if (go === undefined) throw new Error(`no listing ${index} waits`);
      held[index] = () => undefined;
      go();
    },
  };
}

/** A drag event's `dataTransfer` as Finder's would carry it: `Files`, an item per file with its type, and the files on a drop. */
export function filesTransfer(files: readonly { readonly name: string; readonly type: string }[], options: { withFiles?: boolean } = {}) {
  const real = files.map((f) => new File(["x"], f.name, { type: f.type }));
  return { types: ["Files"], items: files.map((f) => ({ kind: "file", type: f.type })), files: options.withFiles === true ? real : [], dropEffect: "none", effectAllowed: "all" };
}
