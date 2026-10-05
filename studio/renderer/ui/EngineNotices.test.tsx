import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { EngineNotice, PhotoSummary } from "../../shared/engine";
import { heldLabel, montagePickRefusal } from "../screens/photos/photoState";
import { EngineNotices } from "./EngineNotices";

// The notices for what stands between the owner and his photos (the engine's `pending-video-unreadable` and `pending-video-set-aside`), and the words a held photo wears.

afterEach(cleanup);

const notice = (code: EngineNotice["code"], count: number): EngineNotice => ({ noticeId: `notice-${code}`, code, at: "2026-10-05T10:00:00.000Z", count });

describe("the notices of unfinished videos", () => {
  test("pending-video-unreadable says the photos may be «заняты», what to do (restart, then update Studio) and how many records, and asks for no file to be found or deleted", () => {
    render(<EngineNotices notices={[notice("pending-video-unreadable", 3)]} dismissed={new Set()} onDismiss={() => undefined} />);

    expect(screen.getByText("Незавершённое видео не прочитано")).toBeDefined();
    const text = document.body.textContent ?? "";
    expect(text).toContain("«заняты»");
    expect(text).toContain("Перезапустите Studio; если не помогло — обновите Studio.");
    expect(text).toContain("Записей: 3.");
    expect(text).not.toContain("удалите");
  });

  test("pending-video-set-aside says nothing is blocked and nothing needs doing, with the number set aside", () => {
    render(<EngineNotices notices={[notice("pending-video-set-aside", 2)]} dismissed={new Set()} onDismiss={() => undefined} />);

    expect(screen.getByText("Повреждённые данные отложены")).toBeDefined();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Фото они не блокируют");
    expect(text).toContain("Записей: 2.");
  });

  test("their count is a number of records, never «Повторилось N раз за эту сессию»", () => {
    render(<EngineNotices notices={[notice("pending-video-unreadable", 5), notice("pending-video-set-aside", 4)]} dismissed={new Set()} onDismiss={() => undefined} />);

    expect(document.body.textContent ?? "").not.toContain("Повторилось");
  });

  test("another notice still says how often it happened", () => {
    render(<EngineNotices notices={[notice("engine-internal-error", 3)]} dismissed={new Set()} onDismiss={() => undefined} />);

    expect((document.body.textContent ?? "").replace(/\s/g, " ")).toContain("Повторилось 3 раза за эту сессию.");
  });
});

describe("a photo held by a render or by an unfinished video", () => {
  const held = { used: false, usedIn: [], reserved: true, rejected: false, eligible: true } as unknown as PhotoSummary;

  test("wears «занято» on its tile, and says why it cannot be picked", () => {
    expect(heldLabel(held)).toBe("занято");
    expect(montagePickRefusal(held)).toBe("Фото занято: в рендере или ждёт незавершённое видео");
  });
});
