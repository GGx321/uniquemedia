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
