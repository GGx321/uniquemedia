import { describe, expect, test } from "bun:test";
import { expectNoKeyFragment } from "../../testing/keyLeaks";
import { REDACTED, redactKnown } from "./redactKnown";

// Every text the flashapi client derives from a response or an error goes through `redactKnown(text, key)` before it
// reaches a log, a quota line or a SafeText. Only fake keys here.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

describe("redactKnown", () => {
  test("removes the whole key wherever it stands, as many times as it stands", () => {
    const text = `bad key ${KEY}; again ${KEY}.`;
    const out = redactKnown(text, KEY);
    expect(out).toBe(`bad key ${REDACTED}; again ${REDACTED}.`);
  });

  test.each([
    ["URL-encoded", encodeURIComponent("Zq7/vKt9+Wm2x Lp4s=0000")],
    ["JSON-escaped", JSON.stringify("Zq7\\vKt9\"Wm2x-Lp4s-0000").slice(1, -1)],
    ["base64", Buffer.from(KEY).toString("base64")],
    ["base64url", Buffer.from(KEY).toString("base64url")],
    ["hex", Buffer.from(KEY).toString("hex")],
  ])("removes the key when it is %s", (_label, encoded) => {
    const key = _label === "URL-encoded" ? "Zq7/vKt9+Wm2x Lp4s=0000" : _label === "JSON-escaped" ? 'Zq7\\vKt9"Wm2x-Lp4s-0000' : KEY;
    const out = redactKnown(`echo ${encoded} end`, key);
    expect(out).not.toContain(encoded);
    expect(out).toContain(REDACTED);
  });

  test.each([
    ["a prefix", KEY.slice(0, 12)],
    ["a suffix", KEY.slice(-12)],
    ["a middle slice", KEY.slice(5, 15)],
    ["a six-char slice", KEY.slice(3, 9)],
  ])("removes %s of the key, so an echo that cut it short leaks nothing", (_label, fragment) => {
    const out = redactKnown(`server says invalid: ${fragment}...`, KEY);
    expectNoKeyFragment(out, KEY);
  });

  test("removes a case-folded echo of the key", () => {
    const out = redactKnown(`normalised to ${KEY.toLowerCase()} and ${KEY.toUpperCase()}`, KEY);
    expectNoKeyFragment(out, KEY);
    expectNoKeyFragment(out.toLowerCase(), KEY.toLowerCase());
  });

  test("leaves the last four chars alone when they stand by themselves: a status may show them", () => {
    expect(redactKnown('{"stored":true,"last4":"0000"}', KEY)).toBe('{"stored":true,"last4":"0000"}');
  });

  test("leaves ordinary text and an unrelated word of five chars alone", () => {
    const text = "flashapi answered 503 Service Unavailable: upstream overloaded (Zq7-v)";
    expect(redactKnown(text, KEY)).toBe(text);
  });

  test("also removes what SECRET_PATTERNS knows: another key's shape, a bearer token, the header line", () => {
    const out = redactKnown("x-rapidapi-key: someone-elses-value and Bearer abc.def", KEY);
    expect(out).not.toContain("someone-elses-value");
    expect(out).not.toContain("abc.def");
  });

  test("handles a key with regex metacharacters and an empty text", () => {
    const odd = "a.b*c+d?e(f)[g]{h}|i^j$k";
    expect(redactKnown(`x ${odd} y`, odd)).toBe(`x ${REDACTED} y`);
    expect(redactKnown("", KEY)).toBe("");
  });

  test("a key too short for windows is still removed whole and nothing throws", () => {
    expect(redactKnown("token abc12 here", "abc12")).toBe(`token ${REDACTED} here`);
  });

  test("a 1 MB text is processed in a fair time", () => {
    const big = `x${KEY}`.repeat(2000) + "y".repeat(1_000_000);
    const started = performance.now();
    const out = redactKnown(big, KEY);
    expect(performance.now() - started).toBeLessThan(2000);
    expectNoKeyFragment(out, KEY);
  });
});
