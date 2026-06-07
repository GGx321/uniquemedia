import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { NField } from "./NField";

test("reports numeric typing and allows clearing, clamps on blur", () => {
  let n = 5;
  render(<NField value={5} onChange={(x) => (n = x)} />);
  const input = screen.getByLabelText("копии") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "30" } });
  expect(n).toBe(30);
  // can be fully cleared in the field
  fireEvent.change(input, { target: { value: "" } });
  expect(input.value).toBe("");
  // blur with empty -> clamps to 1
  fireEvent.blur(input);
  expect(n).toBe(1);
});
