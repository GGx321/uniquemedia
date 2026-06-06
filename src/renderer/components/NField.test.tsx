import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { NField } from "./NField";

test("reports numeric changes, clamps to >= 1", () => {
  let n = 5;
  render(<NField value={5} onChange={(x) => (n = x)} />);
  const input = screen.getByLabelText("копии") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "30" } });
  expect(n).toBe(30);
  fireEvent.change(input, { target: { value: "0" } });
  expect(n).toBe(1);
});
