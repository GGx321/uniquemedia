import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { buildAutopilotCandidates, type AutopilotCandidates } from "../music/autopilotCandidates";
import type { TrendingCandidate } from "../music/trackStore";
import { LastGoodOwnTracks, musicCardOf, type MusicCardDeps } from "./musicCard";
useNativeGlobals();

// S4.10 fix B: the plan card's music line, from the candidate collection and the auto-refresh dry run. A read that fails or does not answer in time never takes the estimate down: the
// saved trends alone are counted, and the refresh reads as «not by itself» (the safe side).

const trend = (trackId: string, explicit = false): TrendingCandidate => ({ source: "trending", trackId, durationMs: 30_000, highlights: [{ ms: 0, likelyDefault: false }], explicit, inList: true });
const found = (trends: TrendingCandidate[], own: string[] = []): AutopilotCandidates => buildAutopilotCandidates({ trends, ownFlagged: own.map((mediaId) => ({ mediaId, durationMs: 20_000 })) });
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function deps(over: Partial<MusicCardDeps> = {}): MusicCardDeps & { asked: number[] } {
  const asked: number[] = [];
  return {
    candidates: () => Promise.resolve(found([trend("a"), trend("b"), trend("rude", true)], ["media-1"])),
    fallback: () => found([trend("a"), trend("b"), trend("rude", true)]),
    outlook: (count) => {
      asked.push(count);
      return Promise.resolve({ autoRefresh: "will" as const, quotaRemaining: 21 });
    },
    readMs: 30,
    ...over,
    asked,
  };
}

describe("musicCardOf", () => {
  test("counts the candidates, the flagged own tracks and the explicit ones left out", async () => {
    expect(await musicCardOf(deps())).toEqual({ candidates: 3, ownFlagged: 1, explicitSkipped: 1, autoRefresh: "will", quotaRemaining: 21 });
  });

  test("asks the refresh rule about the number of candidates it counted", async () => {
    const d = deps();
    await musicCardOf(d);
    expect(d.asked).toEqual([3]);
  });

  test("counts the saved trends alone when the flagged-track read fails", async () => {
    const d = deps({ candidates: () => Promise.reject(new Error("EIO")) });
    expect(await musicCardOf(d)).toMatchObject({ candidates: 2, ownFlagged: 0, explicitSkipped: 1 });
    expect(d.asked).toEqual([2]);
  });

  test("counts the saved trends alone when the flagged-track read does not answer in time", async () => {
    expect(await musicCardOf(deps({ candidates: () => never() }))).toMatchObject({ candidates: 2, ownFlagged: 0 });
  });

  test("counts nothing when even the saved trends cannot be listed", async () => {
    const d = deps({
      candidates: () => Promise.reject(new Error("EIO")),
      fallback: () => {
        throw new Error("store closed");
      },
    });
    expect(await musicCardOf(d)).toMatchObject({ candidates: 0, ownFlagged: 0, explicitSkipped: 0 });
  });

  test("reads the refresh as no-quota with no figure when the dry run fails", async () => {
    expect(await musicCardOf(deps({ outlook: () => Promise.reject(new Error("EIO")) }))).toMatchObject({ autoRefresh: "no-quota", quotaRemaining: null });
  });

  test("reads the refresh as no-quota with no figure when the dry run does not answer in time", async () => {
    expect(await musicCardOf(deps({ outlook: () => never() }))).toMatchObject({ autoRefresh: "no-quota", quotaRemaining: null });
  });

  test("counts the own tracks the fallback remembers when the read does not answer in time", async () => {
    const d = deps({ candidates: () => never(), fallback: () => found([trend("a"), trend("b")], ["media-1", "media-2"]) });
    expect(await musicCardOf(d)).toMatchObject({ candidates: 4, ownFlagged: 2 });
  });

  test("the whole card has one deadline: two reads that never answer take readMs together, not twice", async () => {
    const began = performance.now();
    await musicCardOf(deps({ candidates: () => never(), outlook: () => never(), readMs: 100 }));
    expect(performance.now() - began).toBeLessThan(160);
  });

  test("a dry run that answers at once still counts when the candidates used up the time", async () => {
    expect(await musicCardOf(deps({ candidates: () => never(), readMs: 30 }))).toMatchObject({ autoRefresh: "will", quotaRemaining: 21 });
  });

  test("the dry run is given the time that is left, and gives up with the card", async () => {
    const began = performance.now();
    const slowCandidates = (): Promise<AutopilotCandidates> => new Promise((resolve) => setTimeout(() => resolve(found([trend("a")])), 60));
    const card = await musicCardOf(deps({ candidates: slowCandidates, outlook: () => never(), readMs: 100 }));
    expect([card.autoRefresh, performance.now() - began < 160]).toEqual(["no-quota", true]);
  });
});

describe("LastGoodOwnTracks", () => {
  const track = (mediaId: string) => ({ mediaId, durationMs: 20_000 });

  test("knows nothing of a library it has not read", () => {
    expect(new LastGoodOwnTracks().recall("/library-a")).toEqual([]);
  });

  test("gives back the last read of the library", () => {
    const memory = new LastGoodOwnTracks();
    memory.remember("/library-a", [track("media-1")]);
    expect(memory.recall("/library-a")).toEqual([track("media-1")]);
  });

  test("a later read replaces the earlier one", () => {
    const memory = new LastGoodOwnTracks();
    memory.remember("/library-a", [track("media-1")]);
    memory.remember("/library-a", [track("media-2"), track("media-3")]);
    expect(memory.recall("/library-a").map((t) => t.mediaId)).toEqual(["media-2", "media-3"]);
  });

  test("keeps each library apart: a switch never lends one library's tracks to another", () => {
    const memory = new LastGoodOwnTracks();
    memory.remember("/library-a", [track("media-1")]);
    expect(memory.recall("/library-b")).toEqual([]);
  });

  test("an empty read is a read: the owner unflagged every track", () => {
    const memory = new LastGoodOwnTracks();
    memory.remember("/library-a", [track("media-1")]);
    memory.remember("/library-a", []);
    expect(memory.recall("/library-a")).toEqual([]);
  });
});
