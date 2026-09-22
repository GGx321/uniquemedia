import { test, expect } from "bun:test";
import { FIRST_FRAME_MODES, IDENTITY_MODES } from "./types";

test("IDENTITY_MODES lists engine, iphone and clean, in that order", () => {
  // The order is the order the UI and the CLI usage line present them in:
  // from "says what made it" to "says nothing at all".
  expect(IDENTITY_MODES).toEqual(["engine", "iphone", "clean"]);
});

test("FIRST_FRAME_MODES lists off, black and photo, in that order", () => {
  // The order the UI's segmented control and the CLI usage line present them
  // in: nothing, a blank, a picture.
  expect(FIRST_FRAME_MODES).toEqual(["off", "black", "photo"]);
});
