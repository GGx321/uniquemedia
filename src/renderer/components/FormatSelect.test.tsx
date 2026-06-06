import { test, expect, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { FormatSelect } from "./FormatSelect";

test("changes format on selection", () => {
  let v = "reels";
  render(<FormatSelect value="reels" onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "square" } });
  expect(v).toBe("square");
});
