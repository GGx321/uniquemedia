import { expect, test } from "bun:test";
import { costToMicros, settleRule } from "./settleRule";

const WORST = 50_000;

test("a 2xx with usage.cost settles at that cost, rounded to micro-dollars", () => {
  expect(settleRule({ kind: "response", status: 200, body: { usage: { cost: 0.0112 } } }, WORST)).toEqual({
    action: "settle",
    costMicros: 11_200,
    estimated: false,
  });
});

test("a 2xx with a cost of exactly zero settles at zero, not estimated", () => {
  expect(settleRule({ kind: "response", status: 200, body: { usage: { cost: 0 } } }, WORST)).toEqual({
    action: "settle",
    costMicros: 0,
    estimated: false,
  });
});

test("any 2xx status counts as billed, e.g. 201", () => {
  expect(settleRule({ kind: "response", status: 201, body: { usage: { cost: 0.05 } } }, WORST)).toEqual({
    action: "settle",
    costMicros: 50_000,
    estimated: false,
  });
});

test("a 2xx without usage settles at the worst case, estimated", () => {
  expect(settleRule({ kind: "response", status: 200, body: { data: [] } }, WORST)).toEqual({
    action: "settle",
    costMicros: WORST,
    estimated: true,
  });
});

test("a 2xx with usage.cost null settles at the worst case, estimated", () => {
  expect(settleRule({ kind: "response", status: 200, body: { usage: { cost: null } } }, WORST)).toEqual({
    action: "settle",
    costMicros: WORST,
    estimated: true,
  });
});

test("a 2xx whose body could not be read settles at the worst case, estimated", () => {
  expect(settleRule({ kind: "response", status: 200, body: undefined }, WORST)).toEqual({
    action: "settle",
    costMicros: WORST,
    estimated: true,
  });
});

test("a 2xx with a negative or non-numeric cost settles at the worst case, estimated", () => {
  for (const cost of [-0.01, "0.05", Number.NaN]) {
    expect(settleRule({ kind: "response", status: 200, body: { usage: { cost } } }, WORST)).toEqual({
      action: "settle",
      costMicros: WORST,
      estimated: true,
    });
  }
});

test("a final 4xx refusal settles at zero", () => {
  expect(settleRule({ kind: "response", status: 400, body: { error: { message: "blocked" } } }, WORST)).toEqual({
    action: "settle",
    costMicros: 0,
    estimated: false,
  });
});

test("a final 5xx settles at zero", () => {
  expect(settleRule({ kind: "response", status: 503, body: undefined }, WORST)).toEqual({
    action: "settle",
    costMicros: 0,
    estimated: false,
  });
});

test("a final 429 after transport retries settles at zero", () => {
  expect(settleRule({ kind: "response", status: 429, body: undefined }, WORST)).toEqual({
    action: "settle",
    costMicros: 0,
    estimated: false,
  });
});

test("a non-2xx carrying a usage.cost still settles at zero", () => {
  expect(settleRule({ kind: "response", status: 402, body: { usage: { cost: 0.05 } } }, WORST)).toEqual({
    action: "settle",
    costMicros: 0,
    estimated: false,
  });
});

test("an abort leaves the reserve open", () => {
  expect(settleRule({ kind: "aborted" }, WORST)).toEqual({ action: "leave-open" });
});

test("a timeout leaves the reserve open", () => {
  expect(settleRule({ kind: "timeout" }, WORST)).toEqual({ action: "leave-open" });
});

test("a network error after the request was dispatched leaves the reserve open", () => {
  expect(settleRule({ kind: "network-error", message: "ECONNRESET" }, WORST)).toEqual({ action: "leave-open" });
});

test("a request that never reached fetch is released with its reason", () => {
  expect(settleRule({ kind: "not-sent", reason: "reference image missing" }, WORST)).toEqual({
    action: "release",
    reason: "reference image missing",
  });
});

test("costToMicros rounds float dollars to the nearest integer micro-dollar", () => {
  expect(costToMicros(0.045)).toBe(45_000);
  expect(costToMicros(0.0014)).toBe(1_400);
  expect(costToMicros(0.0000004)).toBe(0);
  expect(costToMicros(0.0000005)).toBe(1);
});
