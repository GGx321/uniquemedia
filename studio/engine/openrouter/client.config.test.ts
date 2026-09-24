import { expect, test } from "bun:test";
import { OPENROUTER_API_BASE } from "../money/prices";
import { createOpenRouterClient } from "./client";
import { OpenRouterError } from "./errors";
import { fakeFetch, LOCAL_BASE, TEST_KEY } from "./testing/fakes";
import type { OpenRouterClientOptions } from "./types";

function options(overrides: Partial<OpenRouterClientOptions>): OpenRouterClientOptions {
  return {
    apiKey: TEST_KEY,
    baseUrl: OPENROUTER_API_BASE,
    allowBaseUrlOverride: false,
    fetch: fakeFetch([]).fetch,
    saveRaw: async () => {},
    ...overrides,
  };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

function codeOf(err: unknown): string | null {
  return err instanceof OpenRouterError ? err.code : null;
}

test("refuses to create a client without an API key, before any request", () => {
  const { fetch, calls } = fakeFetch([]);

  const err = thrownBy(() => createOpenRouterClient(options({ apiKey: "", fetch })));

  expect(codeOf(err)).toBe("NO_API_KEY");
  expect(calls).toHaveLength(0);
});

test("treats a whitespace-only key as no key", () => {
  expect(codeOf(thrownBy(() => createOpenRouterClient(options({ apiKey: "  \n" }))))).toBe("NO_API_KEY");
});

test("refuses a key that cannot be sent as a header value, without echoing it", () => {
  const key = `${TEST_KEY}\nX-Injected: 1`;

  const err = thrownBy(() => createOpenRouterClient(options({ apiKey: key })));

  expect(codeOf(err)).toBe("INVALID_API_KEY");
  expect(String(err)).not.toContain(TEST_KEY);
});

test("accepts the OpenRouter base URL without the override", () => {
  expect(() => createOpenRouterClient(options({ baseUrl: `${OPENROUTER_API_BASE}/` }))).not.toThrow();
});

test("rejects any other base URL when the build does not allow the override", () => {
  const err = thrownBy(() => createOpenRouterClient(options({ baseUrl: LOCAL_BASE, allowBaseUrlOverride: false })));

  expect(codeOf(err)).toBe("BASE_URL_NOT_ALLOWED");
});

test("accepts a loopback base URL when the build allows the override", () => {
  for (const baseUrl of [LOCAL_BASE, "http://localhost:4010/api/v1", "http://[::1]:4010"]) {
    expect(() => createOpenRouterClient(options({ baseUrl, allowBaseUrlOverride: true }))).not.toThrow();
  }
});

test("rejects a non-loopback base URL even when the override is allowed", () => {
  const err = thrownBy(() => createOpenRouterClient(options({ baseUrl: "https://openrouter.example.com/api/v1", allowBaseUrlOverride: true })));

  expect(codeOf(err)).toBe("BASE_URL_NOT_ALLOWED");
});

test("rejects a base URL that carries credentials", () => {
  const err = thrownBy(() => createOpenRouterClient(options({ baseUrl: "http://user:pw@127.0.0.1:9/api/v1", allowBaseUrlOverride: true })));

  expect(codeOf(err)).toBe("BASE_URL_NOT_ALLOWED");
});

test.each([0, -1, 1.5, 180_001, Number.NaN, Number.POSITIVE_INFINITY])("refuses a request timeout of %p ms", (timeoutMs) => {
  expect(() => createOpenRouterClient(options({ timeoutMs }))).toThrow(RangeError);
});

test.each([1, 180_000])("accepts a request timeout of %p ms", (timeoutMs) => {
  expect(() => createOpenRouterClient(options({ timeoutMs }))).not.toThrow();
});

test("rejects a base URL that does not parse", () => {
  const err = thrownBy(() => createOpenRouterClient(options({ baseUrl: "not a url", allowBaseUrlOverride: true })));

  expect(codeOf(err)).toBe("BASE_URL_NOT_ALLOWED");
});
