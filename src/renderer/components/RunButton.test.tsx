import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunButton } from "./RunButton";

test("disabled blocks clicks", () => {
  let clicked = false;
  render(<RunButton disabled running={false} onClick={() => (clicked = true)} />);
  fireEvent.click(screen.getByRole("button"));
  expect(clicked).toBe(false);
});

test("shows running label", () => {
  render(<RunButton disabled={false} running onClick={() => {}} />);
  expect(screen.getByText(/Processing/)).toBeDefined();
});
