import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { CopyQueue } from "./CopyQueue";
import type { UiCopy } from "../types";

test("shows empty message with no copies", () => {
  render(<CopyQueue copies={[]} onOpen={() => {}} onReveal={() => {}} />);
  expect(screen.getByText(/Очередь пуста/i)).toBeDefined();
});

test("renders one card per copy", () => {
  const copies: UiCopy[] = [
    { index: 0, name: "copy_1.mp4", status: "done", verify: { minDistance: 100, passed: true } },
    { index: 1, name: "copy_2.mp4", status: "done", verify: { minDistance: 95, passed: true } },
  ];
  render(<CopyQueue copies={copies} onOpen={() => {}} onReveal={() => {}} />);
  expect(screen.getByText("copy_1.mp4")).toBeDefined();
  expect(screen.getByText("copy_2.mp4")).toBeDefined();
});
