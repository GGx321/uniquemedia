import { expect } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { MAX_LISTED_PHOTOS, type PhotoSummary } from "../../../shared/engine";
import type { MockEngine } from "../../engine/mockEngine";
import { MIA, scenePhoto } from "../../engine/mockEngine.testkit";
import { flush, openSection, setup } from "../../testing";
import { withCounts } from "../montage/screenKit";

// Test support for S4.P2's «Показать ещё» on the «Фото» gallery: a library past 500 photos, the gallery's tiles, and a meter on
// photos.list. Test-only.

const BASE = Date.UTC(2026, 8, 20, 10, 0, 0);

/** Mia's photos 1..`count`, one second apart, days older than anything the mock makes (a run's photos come in front of them). */
export function library(count: number, patch: (n: number) => Partial<PhotoSummary> = () => ({})): PhotoSummary[] {
  return Array.from({ length: count }, (_unused, i) => scenePhoto(i + 1, { createdAt: new Date(BASE + (i + 1) * 1000).toISOString(), ...patch(i + 1) }));
}

/** The Photos screen of Mia over `photos`, its first page in. */
export async function openGallery(photos: PhotoSummary[], options: Omit<Parameters<typeof setup>[0], "avatars" | "photos" | "sceneReview"> = {}) {
  const harness = setup({ avatars: [withCounts(MIA, photos)], photos, sceneReview: "off", ...options });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await waitFor(() => expect(tiles().length).toBe(Math.min(photos.length, MAX_LISTED_PHOTOS)));
  return harness;
}

/** The gallery's photo tiles (not a run's slots, the unreadable note, nor the next page's loading tiles), by photo id. */
export function tiles(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".photos-gallery button.photo-open")).map((b) => b.dataset.photoId ?? "");
}

export function moreButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /^Показать ещё/ });
}

/** Presses «Показать ещё» (or «Повторить») as the keyboard would: focused first. */
export async function press(button: HTMLElement | null): Promise<void> {
  if (button === null) throw new Error("no button to press");
  button.focus();
  fireEvent.click(button);
  await flush();
}

export const tileOf = (photoId: string): HTMLElement | null => document.querySelector<HTMLElement>(`.photos-gallery button.photo-open[data-photo-id="${photoId}"]`);

/** What photos.list was asked from the moment the meter is set: every call's cursor, and the most calls ever in flight at once. */
export interface PhotosListMeter {
  readonly cursors: (string | undefined)[];
  readonly maxInFlight: number;
}

/** Counts the mock's photos.list calls from now on (the client asks `engine.request` at each call, so the wrapper sees them all). */
export function meterPhotosList(engine: MockEngine): PhotosListMeter {
  const meter = { cursors: [] as (string | undefined)[], maxInFlight: 0 };
  let inFlight = 0;
  const original = engine.request.bind(engine);
  engine.request = async (command) => {
    if (command.type !== "photos.list") return original(command);
    meter.cursors.push(command.payload.cursor);
    inFlight++;
    meter.maxInFlight = Math.max(meter.maxInFlight, inFlight);
    try {
      return await original(command);
    } finally {
      inFlight--;
    }
  };
  return meter;
}
