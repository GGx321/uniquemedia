import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import type { PhotoSummary } from "../../shared/engine";
import type { JobView } from "../engine/store";
import { RunOutcome } from "./photos/ScenesColumn";
import { PhotoBadges } from "./photos/photoState";

// S5.6e (mockup 32): the badges of a frame the gate marked and did not retry, and the end-of-run line that counts them.

function photo(id: string, faceCos?: number): PhotoSummary {
  return {
    photoId: id,
    avatarId: "avatar-mia-0001",
    runId: "run-00000001",
    category: "home",
    createdAt: "2026-10-11T10:00:00.000Z",
    ...(faceCos === undefined ? {} : { qa: { faceCos } }),
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
  };
}

function doneRun(photoIds: string[], failedSlots = 0): JobView {
  return {
    jobId: "job-1",
    kind: "run",
    avatarId: "avatar-mia-0001",
    runId: "run-00000001",
    montageId: null,
    videoId: null,
    status: "done",
    saving: false,
    done: photoIds.length,
    total: photoIds.length,
    result: { kind: "run", runId: "run-00000001", avatarId: "avatar-mia-0001", photoIds, failedSlots },
    error: null,
  };
}

describe("the badge of a frame the gate marked", () => {
  test("reads «лицо не проверялось» for a frame with no likeness", () => {
    render(<PhotoBadges photo={photo("p1")} />);
    expect(screen.getByText("лицо не проверялось")).toBeDefined();
  });

  test("reads «лицо 0.48» in the pale style for a one-face frame under the line", () => {
    render(<PhotoBadges photo={photo("p1", 0.48)} />);
    expect(screen.getByText("лицо 0.48").className).toContain("photo-face-low");
  });

  test("offers nothing to click on a marked frame: no retry", () => {
    render(<PhotoBadges photo={photo("p1", 0.48)} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("the end of a run", () => {
  test("counts the frames without a face check beside the gallery line", () => {
    const photos = [photo("p1"), photo("p2", 0.48), photo("p3"), photo("p4", 0.81)];
    render(<RunOutcome job={doneRun(["p1", "p2", "p3", "p4"])} fromSet={false} photos={photos} />);
    expect(screen.getByText(/В галерее 4 фото этого запуска\. 3 кадра без проверки лица\./)).toBeDefined();
  });

  test("says nothing about faces when every frame was checked", () => {
    render(<RunOutcome job={doneRun(["p1"])} fromSet={false} photos={[photo("p1", 0.81)]} />);
    expect(screen.queryByText(/без проверки лица/) === null).toBe(true);
  });

  test("keeps the failed slots after it", () => {
    render(<RunOutcome job={doneRun(["p1"], 2)} fromSet={false} photos={[photo("p1")]} />);
    expect(screen.getByText(/1 кадр без проверки лица\. Не получилось: 2/)).toBeDefined();
  });

  // S5.6R: a slot can end free (`slot-text-problem` ends it with no attempt paid), and the job end carries only the count, so the line must not claim that every failed
  // slot cost something. The reason itself is not on the wire (a contract change, S5.7a).
  test("does not claim that the failed slots were paid for: some close for free", () => {
    render(<RunOutcome job={doneRun(["p1"], 2)} fromSet={false} photos={[photo("p1", 0.81)]} />);
    expect(screen.getByText(/Не получилось: 2\. Если за попытки платили, это уже учтено в расходах\./)).toBeDefined();
    expect(screen.queryByText(/стоимость попыток учтена/) === null).toBe(true);
  });

  test("counts them on a run made from a set too", () => {
    render(<RunOutcome job={doneRun(["p1"])} fromSet={true} photos={[photo("p1")]} />);
    expect(screen.getByText(/1 кадр без проверки лица\./)).toBeDefined();
  });
});
