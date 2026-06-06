import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormatSelect } from "./FormatSelect";

test("changes format on selection", () => {
  let v = "reels";
  render(<FormatSelect value="reels" onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "square" } });
  expect(v).toBe("square");
});

test("renders Оригинал option", () => {
  render(<FormatSelect value="original" onChange={() => {}} />);
  expect(screen.getByRole("option", { name: "Оригинал" })).toBeTruthy();
});
