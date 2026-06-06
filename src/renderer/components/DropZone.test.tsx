import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { DropZone } from "./DropZone";

test("shows prompt when no source", () => {
  render(<DropZone source={null} onPick={() => {}} onDropFile={() => {}} />);
  expect(screen.getByText(/Перетащите видео/i)).toBeDefined();
});

test("shows source name and dims when set", () => {
  render(
    <DropZone
      source={{ name: "clip.mp4", info: { durationSec: 5, width: 1080, height: 1920, hasAudio: true } }}
      onPick={() => {}}
      onDropFile={() => {}}
    />
  );
  expect(screen.getByText(/clip.mp4/)).toBeDefined();
  expect(screen.getByText(/1080×1920/)).toBeDefined();
});
