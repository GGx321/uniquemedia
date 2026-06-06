import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyCard } from "./CopyCard";
import type { UiCopy } from "../types";

const done: UiCopy = {
  index: 6, name: "copy_07.mp4", status: "done",
  verify: { minDistance: 118, passed: true }, thumb: "data:image/jpeg;base64,AAAA",
};

test("renders unique badge", () => {
  render(<CopyCard copy={done} onOpen={() => {}} onReveal={() => {}} />);
  expect(screen.getByText(/Уникально/)).toBeDefined();
});

test("open button fires with the copy name", () => {
  let opened = "";
  render(<CopyCard copy={done} onOpen={() => (opened = done.name)} onReveal={() => {}} />);
  fireEvent.click(screen.getByText(/Открыть/));
  expect(opened).toBe("copy_07.mp4");
});

test("shows a warning badge when not passed", () => {
  render(
    <CopyCard
      copy={{ ...done, verify: { minDistance: 40, passed: false } }}
      onOpen={() => {}}
      onReveal={() => {}}
    />
  );
  expect(screen.getByText(/Слабо/)).toBeDefined();
});
