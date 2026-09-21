import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { BatchProgress } from "./BatchProgress";

test("shows counter and percent", () => {
  render(<BatchProgress index={6} count={30} fraction={0.4} />);
  expect(screen.getByText(/7\/30/)).toBeDefined();
});

test("renders nothing when idle (count 0)", () => {
  const { container } = render(<BatchProgress index={0} count={0} fraction={0} />);
  expect(container.textContent).toBe("");
});

test("names the inter-copy check while it runs, with its own done/total", () => {
  // Every card is already green at this point and the tally reads full, so
  // without a phase of its own the only thing moving is the Stop button —
  // 3 min 40 s of it on a real 50-copy run, read as a hang.
  render(<BatchProgress index={9} count={10} fraction={1} postPass={{ done: 3, total: 10 }} />);
  expect(screen.getByText("Проверка уникальности между копиями")).toBeDefined();
  expect(screen.getByText(/3\/10/)).toBeDefined();
});

test("the phase counter stands in for the batch tally, not beside it", () => {
  render(<BatchProgress index={9} count={10} fraction={1} postPass={{ done: 3, total: 10 }} />);
  expect(screen.queryByText(/10\/10/)).toBeNull();
});

test("shows no phase label when the batch is still rendering copies", () => {
  render(<BatchProgress index={6} count={30} fraction={0.4} postPass={null} />);
  expect(screen.queryByText("Проверка уникальности между копиями")).toBeNull();
  expect(screen.getByText(/7\/30/)).toBeDefined();
});
