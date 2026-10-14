import { describe, expect, test } from "bun:test";
import { clipAttemptId } from "./journal";
import { openClipReserveMicros } from "./openReserve";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const CLIP = "job-00000001";

function ledger(reserves: Record<string, number>, closed: string[] = []) {
  return { reserveOf: (id: string) => (id in reserves ? { worstMicros: reserves[id] ?? 0 } : undefined), closeOf: (id: string) => (closed.includes(id) ? {} : undefined) };
}

describe("openClipReserveMicros", () => {
  const kling = clipAttemptId(CLIP, 1);
  const grok = clipAttemptId(CLIP, 2);

  test("is zero for a clip with no reserve, and for no ledger at all", () => {
    expect(openClipReserveMicros(ledger({}), CLIP)).toBe(0);
    expect(openClipReserveMicros(null, CLIP)).toBe(0);
  });

  test("is the open reserve of the one attempt", () => {
    expect(openClipReserveMicros(ledger({ [kling]: 504_000 }), CLIP)).toBe(504_000);
  });

  test("leaves out a reserve that was settled or released", () => {
    expect(openClipReserveMicros(ledger({ [kling]: 504_000 }, [kling]), CLIP)).toBe(0);
  });

  test("adds the second attempt's reserve to the first one's when both are open", () => {
    expect(openClipReserveMicros(ledger({ [kling]: 504_000, [grok]: 346_000 }), CLIP)).toBe(850_000);
  });

  test("counts only the reserve left open when the first attempt settled", () => {
    expect(openClipReserveMicros(ledger({ [kling]: 504_000, [grok]: 346_000 }, [kling]), CLIP)).toBe(346_000);
  });

  test("never counts another clip's reserve", () => {
    expect(openClipReserveMicros(ledger({ [clipAttemptId("job-00000002", 1)]: 504_000 }), CLIP)).toBe(0);
  });
});
