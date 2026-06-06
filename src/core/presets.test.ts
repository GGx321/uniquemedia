import { test, expect } from "bun:test";
import { PARAMS, PRESET_SCALAR } from "./presets";

test("every param has neutral and positive deviation", () => {
  for (const [key, spec] of Object.entries(PARAMS)) {
    expect(typeof spec.neutral).toBe("number");
    expect(spec.dev).toBeGreaterThan(0);
    expect(key.length).toBeGreaterThan(0);
  }
});

test("preset scalars increase light < medium < aggressive", () => {
  expect(PRESET_SCALAR.light).toBeLessThan(PRESET_SCALAR.medium);
  expect(PRESET_SCALAR.medium).toBeLessThan(PRESET_SCALAR.aggressive);
});
