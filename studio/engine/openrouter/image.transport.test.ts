import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { LedgerLine } from "../money/ledger";
import { fakeFetch, imageBody, imageParams, makeClient, PNG, setupMoney, withoutAt, WORST_ONE_REF, type Money, type Step } from "./testing/fakes";
import type { OpenRouterClientOptions } from "./types";

let money: Money;

beforeEach(async () => {
  money = await setupMoney();
});

afterEach(async () => {
  await money.cleanup();
});

/** Without a working timeout these would wait forever; fail fast instead. */
const FAST = 2_000;
const RESERVE_ONLY = [expect.objectContaining({ type: "reserve", attemptId: "slot-1#1", worstMicros: WORST_ONE_REF })];

async function run(steps: Step[], opts: { overrides?: Partial<OpenRouterClientOptions>; controller?: AbortController; references?: Uint8Array[] } = {}) {
  const { fetch, calls } = fakeFetch(steps);
  const harness = makeClient(fetch, opts.overrides);
  const signal = (opts.controller ?? new AbortController()).signal;
  const result = await harness.client.generateImage(imageParams(money, { signal, ...(opts.references ? { references: opts.references } : {}) }));
  return { result, calls, ...harness };
}

function expectLeftOpen(): void {
  expect(money.lines()).toEqual(RESERVE_ONLY);
  expect(money.budget.inFlightCount()).toBe(0);
  expect(money.budget.status()).toMatchObject({ openAttempts: 1, openReserveMicros: WORST_ONE_REF });
}

// ---------- timeout ----------

test(
  "abandons a request that times out and leaves its reserve open",
  async () => {
    const { result } = await run([{ hang: true }], { overrides: { timeoutMs: 20 } });

    expect(result).toMatchObject({ status: "error", kind: "TIMEOUT", httpStatus: null, fatal: false, ledger: { action: "left-open", worstMicros: WORST_ONE_REF } });
    expectLeftOpen();
  },
  FAST
);

test(
  "times out even when fetch ignores the abort signal",
  async () => {
    const { result } = await run([{ hangForever: true }], { overrides: { timeoutMs: 20 } });

    expect(result).toMatchObject({ status: "error", kind: "TIMEOUT" });
    expectLeftOpen();
  },
  FAST
);

test(
  "settles a 2xx whose body times out at the worst case and stops the pool",
  async () => {
    const { result, raws } = await run([{ status: 200, body: imageBody(PNG, { cost: 0.05 }), bodyHangs: true }], { overrides: { timeoutMs: 20 } });

    expect(result).toMatchObject({ status: "error", kind: "UNUSABLE_PAID_RESPONSE", fatal: true, rawSaved: false, ledger: { action: "settled", costMicros: WORST_ONE_REF, estimated: true } });
    expect(raws).toEqual([]);
  },
  FAST
);

test(
  "treats a non-2xx whose body times out as that status, and retries it",
  async () => {
    const { result, calls } = await run([{ status: 502, bodyHangs: true }, { status: 200, body: imageBody(PNG, { cost: 0.05 }) }], { overrides: { timeoutMs: 20 } });

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ status: "ok", httpTries: 2 });
  },
  FAST
);

test(
  "a timeout on a transport retry leaves the reserve open",
  async () => {
    const { result } = await run([{ status: 503 }, { hang: true }], { overrides: { timeoutMs: 20 } });

    expect(result).toMatchObject({ status: "error", kind: "TIMEOUT" });
    expectLeftOpen();
  },
  FAST
);

// ---------- abort ----------

test(
  "abandons a request aborted in flight and leaves its reserve open",
  async () => {
    const controller = new AbortController();
    const { result } = await run(
      [
        () => {
          controller.abort();
          return { hang: true };
        },
      ],
      { controller }
    );

    expect(result).toEqual({ status: "aborted", ledger: { action: "left-open", worstMicros: WORST_ONE_REF } });
    expectLeftOpen();
  },
  FAST
);

test(
  "settles a 2xx aborted while its body is read at the worst case",
  async () => {
    const controller = new AbortController();
    const { result } = await run(
      [
        () => {
          setTimeout(() => controller.abort(), 5);
          return { status: 200, body: imageBody(PNG, { cost: 0.05 }), bodyHangs: true };
        },
      ],
      { controller }
    );

    expect(result).toEqual({ status: "aborted", ledger: { action: "settled", costMicros: WORST_ONE_REF, estimated: true } });
  },
  FAST
);

test("releases the reserve when the signal aborts after the reserve but before the request is sent", async () => {
  const controller = new AbortController();
  const append = money.ledger.append.bind(money.ledger);
  spyOn(money.ledger, "append").mockImplementation(async (line: LedgerLine) => {
    await append(line);
    if (line.type === "reserve") controller.abort();
  });

  const { result, calls } = await run([], { controller });

  expect(calls).toHaveLength(0);
  expect(result).toEqual({ status: "aborted", ledger: { action: "released" } });
  expect(money.lines().map((l) => l.type)).toEqual(["reserve", "release"]);
});

test("stops at the backoff when the signal aborts, and settles the last non-2xx at zero", async () => {
  const controller = new AbortController();
  const { result, calls } = await run([{ status: 429 }], {
    controller,
    overrides: {
      sleep: async () => {
        controller.abort();
      },
    },
  });

  expect(calls).toHaveLength(1);
  expect(result).toEqual({ status: "aborted", ledger: { action: "settled", costMicros: 0, estimated: false } });
});

// ---------- unexpected errors after the reserve ----------

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

test("an unexpected throw after fetch was called abandons the attempt and rethrows", async () => {
  const boom = new Error("log sink closed");
  const { fetch } = fakeFetch([{ status: 503 }]);
  const { client } = makeClient(fetch, {
    log: () => {
      throw boom;
    },
  });

  const err = await rejection(client.generateImage(imageParams(money)));

  expect(err).toBe(boom);
  expectLeftOpen();
});

test("an unexpected throw before fetch was called releases the attempt and rethrows", async () => {
  const boom = new Error("clock broke");
  const { fetch, calls } = fakeFetch([]);
  const { client } = makeClient(fetch, {
    monotonic: () => {
      throw boom;
    },
  });

  const err = await rejection(client.generateImage(imageParams(money)));

  expect(err).toBe(boom);
  expect(calls).toHaveLength(0);
  expect(money.budget.inFlightCount()).toBe(0);
  expect(money.lines().map((l) => l.type)).toEqual(["reserve", "release"]);
});

// ---------- dispatch and network failures ----------

test("releases the reserve when the request cannot be built (a reference that is not a JPEG)", async () => {
  const { result, calls } = await run([], { references: [PNG] });

  expect(calls).toHaveLength(0);
  expect(result).toMatchObject({ status: "error", kind: "NOT_SENT", fatal: false, httpStatus: null, ledger: { action: "released" } });
  expect(withoutAt(money.lines()).map((l) => l.type)).toEqual(["reserve", "release"]);
});

test("leaves the reserve open when fetch fails after the request was dispatched", async () => {
  const socketClosed = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });

  const { result } = await run([{ reject: socketClosed }]);

  expect(result).toMatchObject({ status: "error", kind: "NETWORK", fatal: false, httpStatus: null, ledger: { action: "left-open", worstMicros: WORST_ONE_REF } });
  expect(result.status === "error" && result.message).toContain("fetch failed");
  expectLeftOpen();
});

test("never retries a network error inside the same attempt id", async () => {
  const { calls } = await run([{ reject: new TypeError("fetch failed") }, { status: 200, body: imageBody(PNG, { cost: 0.05 }) }]);

  expect(calls).toHaveLength(1);
});
