import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { EngineClient } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { EngineProvider } from "../../engine/react";
import { ManualScheduler } from "../../engine/scheduler";
import { ClipPoster } from "./ClipPoster";
import { collageClip, photoClip } from "./testkit";

// 3-H1: a clip as a still (the drafts screen's poster, a video card's) shows an own photo («Мои») as the photo itself, through main's media route by
// its id, as the «Мои» tab's tile does; the dev mock, which stores no picture, draws its stand-in.

const OWN = "media-00000007";

afterEach(cleanup);

function renderPoster(kind: EngineClient["kind"], clip: Parameters<typeof ClipPoster>[0]["clip"]): void {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
  const client: EngineClient = { ...mockEngineClient(engine), kind };
  render(
    <EngineProvider client={client}>
      <ClipPoster clip={clip} avatarId="avatar-mia-0001" />
    </EngineProvider>,
  );
}

describe("an own photo on a clip's poster", () => {
  test("the real client shows the stored photo by its id, in its cell", () => {
    renderPoster("window", { ...photoClip(0, "photo-mia-0001"), cell: { photo: { source: "own", mediaId: OWN }, focus: null } });
    const picture = screen.getByRole("img", { name: "Кадр: своё фото 1" });
    expect(picture.getAttribute("src")).toBe(`studio-media://media/${OWN}`);
    expect(document.querySelector(".clip-poster-own") === null).toBe(true);
  });

  test("in a collage, next to a scene photo; the mock draws its stand-in", () => {
    renderPoster("mock", { ...collageClip(0, ["photo-mia-0001", null], 3_000, false), cells: [{ photo: { source: "scene", photoId: "photo-mia-0001" }, focus: null }, { photo: { source: "own", mediaId: OWN }, focus: null }] });
    expect(screen.getByRole("img", { name: "Кадр: фото 1" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Кадр: своё фото 2" }).className).toContain("portrait-placeholder");
  });
});
