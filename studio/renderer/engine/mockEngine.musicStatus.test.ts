import { describe, expect, test } from "bun:test";
import { MusicStatus, type EngineError } from "../../shared/engine";
import { makeMock, unwrap, type Mock } from "./mockEngine.testkit";

// 3c.6: the dev mock answers the music status, the confirmed refresh and the recovery of a damaged quota log as the engine
// does (studio/engine/music/service.ts), so the Settings card can be built and tested on it. What it does not model: real
// downloads (the tracks `music.list` answers are in mockEngine.musicStore.test.ts).


const status = async (mock: Mock) => MusicStatus.parse(await unwrap(mock.client.request("music.status", {})));
const refresh = (mock: Mock) => mock.client.request("music.refresh", { confirm: true });

async function refused(reply: ReturnType<typeof refresh>): Promise<EngineError> {
  const answer = await reply;
  if (answer.ok) throw new Error("expected a refusal");
  return answer.error;
}


describe("music.status", () => {
  test("of a fresh mock: the engine's never-refreshed status", async () => {
    expect(await status(makeMock())).toEqual({ listFetchedAt: null, trackCount: 0, bytesOnDisk: 0, sentLast31d: 0, limit: 30, serverRemaining: null, nextFreeAt: null, refresh: { state: "idle" }, quotaLog: "ok" });
  });

});

describe("music.refresh, refused at no cost in the engine's order", () => {
  test("no key: MUSIC_KEY_MISSING", async () => {
    const mock = makeMock();
    expect((await refused(refresh(mock))).code).toBe("MUSIC_KEY_MISSING");
    expect((await status(mock)).sentLast31d).toBe(0);
  });

});

