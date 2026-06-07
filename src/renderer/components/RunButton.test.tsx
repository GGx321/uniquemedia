import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunButton } from "./RunButton";

test("shows Stop while running and fires onStop", () => {
  let stopped = false;
  render(<RunButton disabled={false} running onClick={() => {}} onStop={() => (stopped = true)} />);
  fireEvent.click(screen.getByText(/Стоп/));
  expect(stopped).toBe(true);
});

test("disabled blocks the run click", () => {
  let clicked = false;
  render(<RunButton disabled running={false} onClick={() => (clicked = true)} onStop={() => {}} />);
  fireEvent.click(screen.getByRole("button"));
  expect(clicked).toBe(false);
});
