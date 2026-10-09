import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MAX_LISTED_PHOTOS, type PhotoSummary } from "../../shared/engine";
import { scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel } from "../testing";
import { makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";

// S4.P2: the editor's «Фото» bin is a picker of the avatar's photos, so past photos.list's 500 it pages too: «Показать ещё» pinned
// under the bin. (The drafts list reads photos.list only to word why a draft's photo is refused, and lists none: it has no button.)

const BASE = Date.UTC(2026, 8, 20, 10, 0, 0);

function library(count: number): PhotoSummary[] {
  return Array.from({ length: count }, (_unused, i) => scenePhoto(i + 1, { createdAt: new Date(BASE + (i + 1) * 1000).toISOString() }));
}

const media = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
const binItems = (): HTMLElement[] => within(within(media()).getByRole("list", { name: "Фото аватара" })).getAllByRole("listitem");
const moreButton = (): HTMLElement | null => within(media()).queryByRole("button", { name: /^Показать ещё/ });

/** The editor of a one-photo draft of Mia, over `photos`, its bin's first page in. */
async function openEditor(photos: PhotoSummary[]) {
  const harness = await studio({ photos });
  await makeDraft(harness.client, MIA.avatarId, ["photo-mia-0001"]);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("list", { name: "Фото аватара" });
  await waitFor(() => expect(binItems()).toHaveLength(Math.min(photos.length, MAX_LISTED_PHOTOS)));
  return harness;
}

describe("the editor's bin past 500 photos", () => {
  test("500 photos: no «Показать ещё»", async () => {
    await openEditor(library(MAX_LISTED_PHOTOS));
    expect(moreButton() === null).toBe(true);
  });

  test("501: «Показать ещё · 1» under the bin; the press appends the oldest photo once and focuses it, and the button goes", async () => {
    const { engine } = await openEditor(library(MAX_LISTED_PHOTOS + 1));
    const button = moreButton();
    if (button === null) throw new Error("no «Показать ещё»");
    expect(button.textContent).toBe("Показать ещё · 1");
    // The draft's own photo (the oldest) is on the page not read yet.
    expect(media().querySelector('button.ed-bin-pick[data-photo-id="photo-mia-0001"]') === null).toBe(true);
    button.focus();
    fireEvent.click(button);
    await flush();
    await waitFor(() => expect(binItems()).toHaveLength(501));
    const ids = Array.from(media().querySelectorAll<HTMLElement>("button.ed-bin-pick")).map((b) => b.dataset.photoId);
    expect(new Set(ids).size).toBe(501);
    expect(ids.at(-1)).toBe("photo-mia-0001");
    expect(callsOf(engine, "photos.list").filter((c) => c.payload.cursor !== undefined)).toHaveLength(1);
    // Photo 0001 is in the draft (clip 1): its tile selects that clip, and it takes the focus.
    expect(focusedLabel()).toBe(describeElement(media().querySelector('button.ed-bin-pick[data-photo-id="photo-mia-0001"]')));
    expect(focusedLabel()).toBe("button «Фото 501: выбрать кадр 1»");
    expect(moreButton() === null).toBe(true);
    // The bin has no gallery end: nothing more is said once it is whole.
    expect(within(media()).queryByText(/Конец галереи/) === null).toBe(true);
  });
});
