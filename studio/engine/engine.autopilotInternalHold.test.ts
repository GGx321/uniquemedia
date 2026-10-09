import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { expectLaunchInvariants, crashKit, fakeRender } from "./testing/crashKit";
import { ok, portraitPng, useEngineDir } from "./testing/engineHarness";
import { draftOf, LAUNCH_MS, network } from "./testing/wiringKit";
useNativeGlobals();

// Stage 4, S4.6r (plan §4.6, §32): a slice job that ends with a code the failure table has no row for must not hang the launch silently. The REAL engine (default steps, the real run job, a fake
// OpenRouter) is given an avatar whose master photo is damaged on disk: the slice's run ends INTERNAL («the master photo could not be prepared as the face reference») before any request is
// sent. The launch shows an `internal` hold carrying the job's words, «Продолжить» is open, and once the master is whole again it runs the slice and the launch ends done.

setDefaultTimeout(LAUNCH_MS + 40_000);

// Registered BEFORE `useEngineDir`: the engines are shut down before their folder is removed.
afterEach(() => kit.shutdownAll());
const dir = useEngineDir("studio-engine-internal-hold-");
const kit = crashKit(dir);

/** The avatar's master file in the library: the one whose bytes are the portrait the seed stored as the master. */
function masterFile(root: string): string {
  const master = portraitPng(1);
  const walk = (folder: string): string | null => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        const found = walk(path);
        if (found !== null) return found;
      } else if (statSync(path).size === master.length && readFileSync(path).equals(master)) {
        return path;
      }
    }
    return null;
  };
  const found = walk(root);
  if (found === null) throw new Error("the master photo is not in the library");
  return found;
}

describe("a slice whose job ends INTERNAL (S4.6r)", () => {
  test(
    "shows an internal hold with the job's words, sends no request, and «Продолжить» finishes the launch once the master is whole",
    async () => {
      const net = network();
      const avatarId = await kit.seedAvatar(0);
      const path = masterFile(kit.libraryDir());
      const whole = readFileSync(path);
      const started = await kit.boot(net, fakeRender());
      // Damaged on disk: the same length, so the library reads it and finds that its sha256 is not the sidecar's.
      const damaged = Buffer.from(whole);
      damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 0xff;
      writeFileSync(path, damaged);

      const launch = await kit.startLaunch(started, draftOf([avatarId]));
      const held = await kit.waitView(started, launch.launchId, "the internal hold", (v) => v.paidHold?.reason === "internal");
      expect(held.status).toBe("running");
      expect(held.paidHold).toMatchObject({ reason: "internal", detail: { kind: "job-failed" } });
      const words = held.paidHold?.reason === "internal" ? (held.paidHold.detail.message ?? "") : "";
      expect(words).toContain("INTERNAL: the master photo could not be prepared as the face reference");
      expect(held.resumeBlockedBy).toBeNull();
      expect(held.avatars[0]?.phase).toBe("waiting");
      expect(held.logTail.find((l) => l.kind === "hold-internal")).toMatchObject({ holdKind: "job-failed", detail: words });
      // Nothing was sent for the photos: only the scene writer ran (the compose is before the slice).
      expect(net.imageCalls()).toEqual([]);

      writeFileSync(path, whole);
      // «Продолжить · до $R» with R = max(0, W′ − spent) as the view states it (invariant 4): a micro-dollar less is refused and the launch keeps its hold.
      const before = held;
      const accepted = before.remainingMicros;
      expect(accepted).toBe(Math.max(0, before.plannedWorstMicros - before.spentMicros));
      expect(accepted).toBeGreaterThan(0);
      const short = await kit.call(started, "autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: accepted - 1 });
      expect(short.ok).toBe(false);
      if (!short.ok) expect(short.error.code).toBe("PRICE_CHANGED");
      expect((await kit.getLaunch(started, launch.launchId)).launch.paidHold?.reason).toBe("internal");
      ok(await kit.call(started, "autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: accepted }));
      await kit.drive(started, launch.launchId, "the launch to be done", (v) => v.status === "done");
      expect(net.imageCalls()).toHaveLength(10);
      await expectLaunchInvariants(kit, started, { launchId: launch.launchId, avatarId, firstRequests: 0, net, accepted, before, generates: true });
    },
    LAUNCH_MS + 30_000,
  );
});
