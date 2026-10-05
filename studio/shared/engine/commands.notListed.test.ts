import { describe, expect, test } from "bun:test";
import { OkResponse } from "./commands";

// `montages.list`'s notListedTotal is additive and absent when 0: a present 0 is a second way of saying «nothing», which the contract does not take.

const answer = (result: Record<string, unknown>) => OkResponse.safeParse({ v: 5, id: "msg-000001", kind: "response", type: "montages.list", ok: true, result });

describe("montages.list notListedTotal", () => {
  test("is accepted when above 0", () => {
    expect(answer({ items: [], total: 0, skippedTotal: 0, notListedTotal: 3 }).success).toBe(true);
  });

  test("may be absent", () => {
    expect(answer({ items: [], total: 0, skippedTotal: 0 }).success).toBe(true);
  });

  test("is refused when 0: it is left out instead", () => {
    expect(answer({ items: [], total: 0, skippedTotal: 0, notListedTotal: 0 }).success).toBe(false);
  });
});
