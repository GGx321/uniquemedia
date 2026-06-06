import { test, expect } from "bun:test";
import { makeRng, rngRange, rngInt, rngBool, rngPick } from "./rng";

test("same seed produces same sequence", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  expect([a(), a(), a()]).toEqual([b(), b(), b()]);
});

test("different seeds diverge", () => {
  const a = makeRng(1);
  const b = makeRng(2);
  expect(a()).not.toBe(b());
});

test("rng() stays in [0,1)", () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});

test("rngRange respects bounds", () => {
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rngRange(r, -2, 5);
    expect(v).toBeGreaterThanOrEqual(-2);
    expect(v).toBeLessThan(5);
  }
});

test("rngInt is inclusive of max", () => {
  const r = makeRng(3);
  const seen = new Set<number>();
  for (let i = 0; i < 500; i++) seen.add(rngInt(r, 1, 3));
  expect([...seen].sort()).toEqual([1, 2, 3]);
});

test("rngBool and rngPick are deterministic", () => {
  const r = makeRng(9);
  expect(typeof rngBool(r)).toBe("boolean");
  expect(["a", "b", "c"]).toContain(rngPick(r, ["a", "b", "c"]));
});
