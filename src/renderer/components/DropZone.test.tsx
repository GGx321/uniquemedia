import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DropZone } from "./DropZone";
import type { MediaInfo } from "../../core/types";

const videoInfo: MediaInfo = { kind: "video", durationSec: 5, width: 1080, height: 1920, hasAudio: true };
const photoInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 4032, height: 3024, hasAudio: false };

test("shows prompt when no source", () => {
  render(<DropZone source={null} onPick={() => {}} onDropFile={() => {}} />);
  expect(screen.getByText(/Перетащите видео или фото/i)).toBeDefined();
});

test("shows source name and dims when set", () => {
  render(
    <DropZone
      source={{ name: "clip.mp4", info: videoInfo }}
      onPick={() => {}}
      onDropFile={() => {}}
    />
  );
  expect(screen.getByText(/clip.mp4/)).toBeDefined();
  expect(screen.getByText(/1080×1920/)).toBeDefined();
});

test("shows analyzing indicator when analyzing is true", () => {
  render(
    <DropZone
      source={null}
      analyzing={true}
      onPick={() => {}}
      onDropFile={() => {}}
    />
  );
  expect(screen.getByText(/Анализ файла/i)).toBeDefined();
  expect(screen.queryByText(/Перетащите/i)).toBeNull();
});

test("marks a video source with the play glyph", () => {
  const { container } = render(
    <DropZone source={{ name: "clip.mp4", info: videoInfo }} onPick={() => {}} onDropFile={() => {}} />
  );
  expect(container.querySelector('[data-glyph="play"]')).not.toBeNull();
  expect(container.querySelector('[data-glyph="still"]')).toBeNull();
});

test("marks a photo source with the still-image glyph, not the play triangle", () => {
  const { container } = render(
    <DropZone source={{ name: "IMG_0042.jpg", info: photoInfo }} onPick={() => {}} onDropFile={() => {}} />
  );
  expect(container.querySelector('[data-glyph="still"]')).not.toBeNull();
  expect(container.querySelector('[data-glyph="play"]')).toBeNull();
});

test("keeps the crop-mark framing whatever the source kind", () => {
  // The styling hangs off these class names; a glyph swap must not disturb them.
  const { container } = render(
    <DropZone source={{ name: "IMG_0042.jpg", info: photoInfo }} onPick={() => {}} onDropFile={() => {}} />
  );
  expect(container.querySelectorAll(".crop-mark").length).toBe(4);
  expect(container.querySelector(".source-thumb")).not.toBeNull();
});
