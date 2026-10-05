import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, createEvent, fireEvent, within } from "@testing-library/react";
import { ENGINE_GONE_DETAIL, mediaReasonRu } from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import { mockDropDoor } from "../engine/mockMineDemo";
import { callsOf, flush } from "../testing";
import { dropZone, filesTransfer, media, mineStudio, openMine, plain, section, seedMine } from "./montage/mineScreenKit";

// 3f.6 round 2 (M13, the owner's decision of 2026-10-04): files dragged from Finder or Explorer onto the drop zone. While they are over it the
// zone says what it will take («Отпустите — добавим 3 файла · 2 фото, 1 видео», counted by the items' types); the drop hands the client's door
// the `File` objects and nothing else, and its answer goes through the same result card as a pick. The zone takes nothing while the engine is
// away or a pick is open; and it never names a path.

let errors: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  errors?.mockRestore();
  errors = null;
});

/** A dragover on the zone, kept so a test can read what the zone set on its transfer. */
const dragOverEvent = (dataTransfer: ReturnType<typeof filesTransfer>): DragEvent => {
  const event = createEvent.dragOver(dropZone(), { dataTransfer });
  if (!(event instanceof DragEvent)) throw new Error("not a drag event");
  return event;
};

/** The mock with a drop door that records what the window handed it. */
function withDoor(given: File[][]) {
  return (client: EngineClient, engine: Parameters<typeof mockDropDoor>[0]): EngineClient => {
    const door = mockDropDoor(engine, client);
    return {
      ...client,
      importDropped: (files) => {
        given.push([...files]);
        return door(files);
      },
    };
  };
}

describe("a drag of files over the drop zone (M13)", () => {
  test("the zone says what it will take, counted by type; leaving it puts it back", async () => {
    const { engine, client } = await mineStudio(withDoor([]));
    await openMine(engine, client);
    const zone = dropZone();
    fireEvent.dragEnter(zone, { dataTransfer: filesTransfer([{ name: "a.jpg", type: "image/jpeg" }, { name: "b.png", type: "image/png" }, { name: "c.mov", type: "video/quicktime" }]) });
    expect(plain(dropZone().textContent)).toBe("Отпустите — добавим 3 файла2 фото, 1 видео");
    expect(dropZone().className).toContain("drop-over");
    fireEvent.dragLeave(dropZone(), { relatedTarget: null });
    expect(plain(dropZone().textContent)).toBe("Добавить файлыфото, видео, музыка, стикеры · перетащите или нажмите");
  });

  test("a type the drag does not say: «N файлов» with the kinds the zone takes", async () => {
    const { engine, client } = await mineStudio(withDoor([]));
    await openMine(engine, client);
    fireEvent.dragOver(dropZone(), { dataTransfer: filesTransfer([{ name: "Holiday", type: "" }, { name: "a.jpg", type: "image/jpeg" }]) });
    expect(plain(dropZone().textContent)).toBe("Отпустите — добавим 2 файлафото, видео, музыка, стикеры");
  });

  test("the zone takes the drag itself (round 2, N18): a drag over it and a drop on it have their default (open the file) prevented, and say «copy»", async () => {
    const { engine, client } = await mineStudio(withDoor([]));
    await openMine(engine, client);
    const over = dragOverEvent(filesTransfer([{ name: "a.jpg", type: "image/jpeg" }]));
    expect(fireEvent(dropZone(), over)).toBe(false);
    expect(over.dataTransfer?.dropEffect).toBe("copy");
    expect(fireEvent.drop(dropZone(), { dataTransfer: filesTransfer([{ name: "a.jpg", type: "image/jpeg" }], { withFiles: true }) })).toBe(false);
  });

  test("while a pick is open the zone says nothing of a drag and the cursor says no (round 2, N12)", async () => {
    const { engine, client } = await mineStudio(withDoor([]));
    await openMine(engine, client);
    engine.delayNext("media.pickImport", 5_000);
    fireEvent.click(dropZone());
    await flush();
    const over = dragOverEvent(filesTransfer([{ name: "a.jpg", type: "image/jpeg" }]));
    fireEvent(dropZone(), over);
    expect(over.dataTransfer?.dropEffect).toBe("none");
    expect(plain(dropZone().textContent)).toContain("Добавить файлы");
  });

  test("text or a link dropped on the zone never reaches the import door, and is not taken (round 2, LOW-3)", async () => {
    const given: File[][] = [];
    const { engine, client } = await mineStudio(withDoor(given));
    await openMine(engine, client);
    for (const types of [["text/plain"], ["text/uri-list", "text/html"]]) {
      const transfer = { types, items: types.map((type) => ({ kind: "string", type })), files: [], dropEffect: "none" };
      expect(fireEvent.drop(dropZone(), { dataTransfer: transfer })).toBe(true);
    }
    await flush();
    expect(given).toEqual([]);
    expect(callsOf(engine, "media.pickImport")).toHaveLength(0);
  });

  test("a drag that holds no file (text from a page) leaves the zone as it is", async () => {
    const { engine, client } = await mineStudio(withDoor([]));
    await openMine(engine, client);
    fireEvent.dragEnter(dropZone(), { dataTransfer: { types: ["text/plain"], items: [{ kind: "string", type: "text/plain" }], files: [] } });
    expect(plain(dropZone().textContent)).toContain("Добавить файлы");
  });
});

describe("the drop", () => {
  test("hands the door the File objects themselves; a refused file is said with its reason, the others go in (the pick's own card)", async () => {
    const given: File[][] = [];
    const { engine, client, scheduler } = await mineStudio(withDoor(given));
    await openMine(engine, client);
    const transfer = filesTransfer([{ name: "beach.jpg", type: "image/jpeg" }, { name: "track.wma", type: "" }, { name: "walk.mp4", type: "video/mp4" }], { withFiles: true });
    fireEvent.drop(dropZone(), { dataTransfer: transfer });
    await flush();
    expect(given).toHaveLength(1);
    expect(given[0]?.map((f) => f.name)).toEqual(["beach.jpg", "track.wma", "walk.mp4"]);
    expect(given[0]?.[0]).toBe(transfer.files[0]);
    const card = within(media()).getByRole("alert");
    expect(plain(card.textContent)).toContain("track.wma не подходит");
    expect(plain(card.textContent)).toContain(mediaReasonRu("format"));
    expect(plain(card.textContent)).toContain("Остальные 2 файла добавляем.");
    act(() => scheduler.runAll());
    await flush();
    expect(plain(within(media()).getByRole("alert").textContent)).toContain("Остальные 2 файла добавлены.");
    expect(within(section("Фото и видео")).getByRole("button", { name: "Фото beach.jpg: добавить кадр в конец ролика" })).toBeDefined();
    // The zone is itself again.
    expect(plain(dropZone().textContent)).toContain("Добавить файлы");
  });

  test("two refused files of the same name are both said (round 1, L6: no clash of React keys)", async () => {
    errors = spyOn(console, "error");
    const { engine, client } = await mineStudio(withDoor([]));
    await openMine(engine, client);
    fireEvent.drop(dropZone(), { dataTransfer: filesTransfer([{ name: "notes.pdf", type: "" }, { name: "notes.pdf", type: "" }], { withFiles: true }) });
    await flush();
    const card = within(media()).getByRole("alert");
    expect(plain(card.textContent).split("notes.pdf:")).toHaveLength(3);
    expect(errors.mock.calls.some((call: unknown[]) => String(call[0]).includes("same key"))).toBe(false);
  });

  test("a client without a drop door takes no drop: nothing is sent", async () => {
    const { engine, client } = await mineStudio();
    await openMine(engine, client);
    fireEvent.drop(dropZone(), { dataTransfer: filesTransfer([{ name: "beach.jpg", type: "image/jpeg" }], { withFiles: true }) });
    await flush();
    expect(callsOf(engine, "media.pickImport")).toHaveLength(0);
    expect(within(media()).queryByRole("alert") === null).toBe(true);
  });
});

describe("while the zone cannot take files (round 1, L10)", () => {
  test("a pick is open: the zone is busy, a second click sends nothing, and a drop is not taken", async () => {
    const given: File[][] = [];
    const { engine, client } = await mineStudio(withDoor(given));
    await openMine(engine, client);
    engine.delayNext("media.pickImport", 5_000);
    fireEvent.click(dropZone());
    await flush();
    expect(dropZone().getAttribute("aria-busy")).toBe("true");
    expect(dropZone().hasAttribute("disabled")).toBe(true);
    fireEvent.click(dropZone());
    fireEvent.drop(dropZone(), { dataTransfer: filesTransfer([{ name: "beach.jpg", type: "image/jpeg" }], { withFiles: true }) });
    await flush();
    expect(callsOf(engine, "media.pickImport")).toHaveLength(1);
    expect(given).toEqual([]);
  });

  test("the engine away: the zone is off, takes no drop, and «Удалить» in a confirmation is off", async () => {
    const given: File[][] = [];
    const { engine, client } = await mineStudio(withDoor(given));
    seedMine(engine);
    await openMine(engine, client);
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Удалить croissant.jpg" }));
    engine.failNext("engine.events", { code: "INTERNAL" });
    engine.failNext("engine.snapshot", { code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(plain(within(media()).getByRole("status").textContent)).toContain("Движок Studio недоступен");
    expect(dropZone().hasAttribute("disabled")).toBe(true);
    fireEvent.drop(dropZone(), { dataTransfer: filesTransfer([{ name: "beach.jpg", type: "image/jpeg" }], { withFiles: true }) });
    await flush();
    expect(given).toEqual([]);
    expect(within(within(media()).getByRole("alert")).getByRole("button", { name: "Удалить" }).hasAttribute("disabled")).toBe(true);
  });
});
