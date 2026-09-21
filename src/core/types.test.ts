import { test, expect } from "bun:test";
import { IDENTITY_MODES } from "./types";

test("IDENTITY_MODES lists engine, iphone and clean, in that order", () => {
  // The order is the order the UI and the CLI usage line present them in:
  // from "says what made it" to "says nothing at all".
  expect(IDENTITY_MODES).toEqual(["engine", "iphone", "clean"]);
});
