import { expect, test } from "bun:test";
import { sameJson } from "./json";

// A montage spec is JSON-shaped: the editor compares versions by value, never by reference or key order.

test("objects are equal by their keys and values, whatever the key order", () => {
  expect(sameJson({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
});

test("a missing key, an extra key, or an undefined value in place of a missing one tell objects apart", () => {
  expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  expect(sameJson({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  expect(sameJson({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);
});

test("arrays are equal only in the same order", () => {
  expect(sameJson([1, 2, 3], [1, 2, 3])).toBe(true);
  expect(sameJson([1, 2, 3], [3, 2, 1])).toBe(false);
  expect(sameJson([1, 2], [1, 2, 3])).toBe(false);
});

test("null, numbers, strings and booleans compare by value; an array is not an object with index keys", () => {
  expect(sameJson(null, null)).toBe(true);
  expect(sameJson(null, {})).toBe(false);
  expect(sameJson(0, -0)).toBe(true);
  expect(sameJson("a", "a")).toBe(true);
  expect(sameJson(true, 1)).toBe(false);
  expect(sameJson([1], { 0: 1 })).toBe(false);
});
