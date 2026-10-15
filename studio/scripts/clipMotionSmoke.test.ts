import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { canaryProblems, motionLedgerProblems } from "./clipMotionSmoke";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC4: what the E2E smoke (smoke-engine.ts) checks of part C, as functions with no Electron in them. The smoke only has to call them with what its mock and the app reported; this file holds
// them, and clipMotionSmoke.engine.test.ts runs the same steps against the real engine on loopback.

const IDEA = "медленно поворачивает голову к окну и улыбается, CANARY-9c41";

describe("canaryProblems (I5.67: the owner's words are in the translator's request and nowhere else)", () => {
  test("is empty when no place holds a fragment of the idea", () => {
    expect(canaryProblems(IDEA, [{ where: "the ledger", text: '{"type":"reserve"}' }, { where: "an event", text: '{"label":"медленно поворачивает голову к окну…"}' }])).toEqual([]);
  });

  test("names a place that holds the whole idea", () => {
    expect(canaryProblems(IDEA, [{ where: "the store", text: `{"text":"${IDEA}"}` }])).toEqual(["the store holds a fragment of the idea (41 characters from character 0)"]);
  });

  test("names a place that holds only a 41-character fragment", () => {
    const fragment = IDEA.slice(10, 51);
    expect(canaryProblems(IDEA, [{ where: "a log line", text: `[x] ${fragment} [y]` }])).toEqual(["a log line holds a fragment of the idea (41 characters from character 10)"]);
  });

  test("lets the label through: his first 40 characters are the label, and 40 characters are not a fragment", () => {
    expect(canaryProblems(IDEA, [{ where: "the clip record", text: IDEA.slice(0, 40) }])).toEqual([]);
  });

  test("sees the idea JSON-escaped and \\u-escaped, in either case, as a raw body of an answer could echo it", () => {
    const json = JSON.stringify(IDEA).slice(1, -1);
    const escaped = [...IDEA].map((c) => (/[^\x20-\x7e]/.test(c) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c)).join("");
    expect(canaryProblems(IDEA, [{ where: "json", text: json }])).toHaveLength(1);
    expect(canaryProblems(IDEA, [{ where: "lower", text: escaped }])).toHaveLength(1);
    expect(canaryProblems(IDEA, [{ where: "upper", text: escaped.replace(/\\u([0-9a-f]{4})/g, (_m, hex: string) => `\\u${hex.toUpperCase()}`) }])).toHaveLength(1);
  });

  test("refuses an idea of 40 characters or fewer: its label would be all of it, and the canary would prove nothing", () => {
    expect(canaryProblems("короткая идея", [{ where: "x", text: "y" }])).toEqual(["the idea is not longer than 40 characters, so a fragment of it cannot be told from its label"]);
  });
});

describe("motionLedgerProblems", () => {
  const reserve = (attemptId: string) => ({ type: "reserve", attemptId });
  const settle = (attemptId: string) => ({ type: "settle", attemptId });

  test("is empty for a suggestion and an idea, each reserved once and settled", () => {
    const lines = [reserve("job-1:motion#1"), settle("job-1:motion#1"), reserve("job-2:idea#1"), settle("job-2:idea#1")];
    expect(motionLedgerProblems(lines, ["motion", "idea"])).toEqual([]);
  });

  test("names a call that was reserved and never settled", () => {
    expect(motionLedgerProblems([reserve("job-1:motion#1")], ["motion"])).toEqual(["job-1:motion#1 was reserved and never settled"]);
  });

  test("names a missing or an extra call", () => {
    expect(motionLedgerProblems([reserve("job-1:motion#1"), settle("job-1:motion#1")], ["motion", "idea"])).toEqual(["2 part C calls were expected, 1 reserved"]);
    expect(motionLedgerProblems([reserve("job-1:idea#1"), settle("job-1:idea#1")], ["motion"])).toEqual(['call 1 was "idea", expected "motion"']);
  });

  test("ignores the lines of other attempts", () => {
    expect(motionLedgerProblems([reserve("job-0:video#1"), settle("job-0:video#1")], [])).toEqual([]);
  });
});
