import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { until } from "../testing/engineHarness";
import { A } from "./testing/launchFixtures";
import { MUSIC, rig, settleFor, useRigCleanup, videosOf } from "./testing/freeRig";
useNativeGlobals();
useRigCleanup();

// S4.6c2 (plan §22 «Contract follow-up», backlog «#loggedWait»): when the library cannot tell which photos are free (unknown usage or drafts, a record that does not read, recovery still
// running), the avatar WAITS with the reason `library-unknown` and the log says so ONCE per wait. It is not `avatar-busy`, which means «the owner's generation is running». The wait ends
// only when the avatar is OBSERVED ready: a look that does not reach the avatar (a backoff) does not end it, so the line is not written again at every recheck (it was ~450 an hour).

const waitingLines = (logs: ReadonlyArray<{ kind: string }>): number => logs.filter((l) => l.kind === "library-unknown").length;

describe("the library cannot say which photos are free", () => {
  test("an avatar whose usage is unknown waits as library-unknown, picks nothing and drops nothing", async () => {
    const r = rig({ draft: { videosPerAvatar: 2 } });
    r.library.breakUsage(A);
    r.start();
    await until(() => r.launch.file().avatars[0]?.waiting?.reason === "library-unknown", "the waiting row", 4_000);
    expect(r.launch.file().avatars[0]?.phase).toBe("waiting");
    expect(videosOf(r.launch).map((v) => v.state)).toEqual(["planned", "planned"]);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("the log says it once and never as avatar-busy, however long the wait takes", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.library.breakUsage(A);
    r.start();
    await until(() => waitingLines(r.launch.logs) === 1, "the log line", 4_000);
    await settleFor(150);
    expect(waitingLines(r.launch.logs)).toBe(1);
    expect(r.launch.logs.some((l) => l.kind === "avatar-busy")).toBe(false);
  });

  test("when the library can say again the row leaves the wait and the launch carries on to its end", async () => {
    const r = rig({ draft: { videosPerAvatar: 1 } });
    r.library.breakUsage(A);
    r.start();
    await until(() => r.launch.file().avatars[0]?.phase === "waiting", "the waiting row", 4_000);
    r.library.breakUsage(A, false);
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().avatars[0]).toMatchObject({ phase: "done", waiting: null });
  });

  test("a second wait after the first has ended is a new episode and is logged again", async () => {
    let trackReady = false;
    const r = rig({ draft: { videosPerAvatar: 1 }, deps: { chooseMusic: async () => (trackReady ? { kind: "chosen", music: MUSIC } : { kind: "waiting", reason: "no-candidate" }) } });
    r.library.breakUsage(A);
    r.start();
    await until(() => waitingLines(r.launch.logs) === 1, "the first line", 4_000);
    r.library.breakUsage(A, false);
    await until(() => videosOf(r.launch)[0]?.state === "waiting-music" && r.launch.file().avatars[0]?.waiting === null, "the first wait to end", 4_000);
    r.library.breakUsage(A);
    trackReady = true;
    await until(() => waitingLines(r.launch.logs) === 2, "the second line", 4_000);
  });
});

describe("the wait line is written once per episode, not once per recheck", () => {
  test("a video that cannot be submitted because the usage broke after its assignment logs one line over many rechecks", async () => {
    let broke = false;
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: {
        recheckMs: 40,
        chooseMusic: async () => {
          if (!broke) {
            broke = true;
            r.library.breakUsage(A);
          }
          return { kind: "chosen", music: MUSIC };
        },
      },
    });
    r.start();
    await until(() => waitingLines(r.launch.logs) === 1, "the first line", 4_000);
    await settleFor(220);
    expect(waitingLines(r.launch.logs)).toBe(1);
    expect(r.videos.calls).toHaveLength(0);
  });

  test("the row shows the wait through the backoff too, and clears it once the avatar is seen ready", async () => {
    let broke = false;
    const r = rig({
      draft: { videosPerAvatar: 1 },
      deps: {
        recheckMs: 40,
        chooseMusic: async () => {
          if (!broke) {
            broke = true;
            r.library.breakUsage(A);
          }
          return { kind: "chosen", music: MUSIC };
        },
      },
    });
    r.start();
    await until(() => r.launch.file().avatars[0]?.waiting?.reason === "library-unknown", "the waiting row", 4_000);
    await settleFor(100);
    expect(r.launch.file().avatars[0]?.phase).toBe("waiting");
    r.library.breakUsage(A, false);
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().avatars[0]).toMatchObject({ phase: "done", waiting: null });
  });

  test("a key held by recovery waits as library-unknown, once, and the row clears when the record is there", async () => {
    const r = rig({
      draft: { videosPerAvatar: 1 },
      file: (file) => ({ ...file, avatars: file.avatars.map((a) => ({ ...a, videos: a.videos.map((v) => ({ ...v, state: "rendering" as const, photoIds: ["photo-held-0001"], videoId: null, music: MUSIC })) })) }),
    });
    r.provenance.intents.set("0-1", "video-0000ad04");
    r.start();
    await until(() => waitingLines(r.launch.logs) === 1, "the log line", 4_000);
    await settleFor(80);
    expect(waitingLines(r.launch.logs)).toBe(1);
    expect(r.launch.file().avatars[0]).toMatchObject({ phase: "waiting", waiting: { reason: "library-unknown" } });
    r.provenance.intents.delete("0-1");
    r.provenance.records.set("0-1", { videoId: "video-0000ad04", durationMs: 7000, bytes: 4096 });
    await until(() => r.launch.finished(), "the launch to finish", 4_000);
    expect(r.launch.file().avatars[0]).toMatchObject({ phase: "done", waiting: null });
  });
});

describe("a row the paid path owns keeps its phase", () => {
  test("an avatar with generated photos is logged as library-unknown but its phase and waiting are left to the paid path", async () => {
    const r = rig({ draft: { library: false, generate: true, videosPerAvatar: 1 }, slices: () => ({ runIds: ["run-slice-0001"], over: true }) });
    r.library.breakUsage(A);
    const before = r.launch.file().avatars[0];
    r.start();
    await until(() => waitingLines(r.launch.logs) === 1, "the log line", 4_000);
    await settleFor(60);
    expect(waitingLines(r.launch.logs)).toBe(1);
    expect(r.launch.file().avatars[0]?.phase).toBe(before?.phase);
    expect(r.launch.file().avatars[0]?.waiting).toBeNull();
  });
});
