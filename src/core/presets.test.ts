import { test, expect } from "bun:test";
import { PARAMS } from "./presets";

test("every param has neutral and positive deviation", () => {
  for (const [key, spec] of Object.entries(PARAMS)) {
    expect(typeof spec.neutral).toBe("number");
    expect(spec.dev).toBeGreaterThan(0);
    expect(key.length).toBeGreaterThan(0);
  }
});
