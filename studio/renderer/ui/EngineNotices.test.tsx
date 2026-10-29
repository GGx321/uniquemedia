import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { EngineNotice } from "../../shared/engine";
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

  test("their count is a number of records, never «Повторилось N раз за эту сессию»", () => {
    render(<EngineNotices notices={[notice("pending-video-unreadable", 5), notice("pending-video-set-aside", 4)]} dismissed={new Set()} onDismiss={() => undefined} />);

    expect(document.body.textContent ?? "").not.toContain("Повторилось");
  });

});
