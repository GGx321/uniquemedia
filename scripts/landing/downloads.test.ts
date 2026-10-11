import { describe, expect, test } from "bun:test";
import {
  CACHE_WAIT_SECONDS,
  SIZE_LIMIT_BYTES,
  buildLatest,
  checkDowngrade,
  classifyAsset,
  classifyAssets,
  currentRefsOf,
  currentVersionOf,
  effectiveVersion,
  executePlan,
  parseVersion,
  planUpload,
  type Plan,
  type PlanIo,
} from "./downloads";

describe("classifyAssets", () => {
  test("picks exactly one dmg and one exe, ignoring other files", () => {
    expect(classifyAssets(["a.dmg", "b.exe", "latest.yml", "a.dmg.blockmap"])).toEqual({ mac: "a.dmg", win: "b.exe" });
  });
  test("fails when an installer is missing", () => {
    expect(() => classifyAssets(["a.dmg"])).toThrow(/\.exe/);
    expect(() => classifyAssets(["b.exe"])).toThrow(/\.dmg/);
    expect(() => classifyAssets([])).toThrow();
  });
  test("fails on more than one of a kind, before anything is uploaded", () => {
    expect(() => classifyAssets(["a.dmg", "c.dmg", "b.exe"])).toThrow(/more than one/i);
    expect(() => classifyAssets(["a.dmg", "b.exe", "c.exe"])).toThrow(/more than one/i);
  });
});

describe("currentVersionOf", () => {
  test("reads a valid latest.json", () => {
    expect(currentVersionOf({ version: "0.6.0", mac: "m", win: "w", publishedAt: "t" })).toBe("0.6.0");
  });
  test("rejects anything else rather than guessing", () => {
    for (const bad of [null, "x", {}, { version: 6 }, { version: "v0.6.0" }, { version: "0.6" }]) {
      expect(() => currentVersionOf(bad)).toThrow();
    }
  });
});

describe("checkDowngrade", () => {
  test("allows newer and equal versions", () => {
    expect(() => checkDowngrade("0.6.1", "0.6.0", false)).not.toThrow();
    expect(() => checkDowngrade("0.6.0", "0.6.0", false)).not.toThrow();
    expect(() => checkDowngrade("0.6.0", null, false)).not.toThrow();
  });
  test("compares numerically, not as strings", () => {
    expect(() => checkDowngrade("0.10.0", "0.9.0", false)).not.toThrow();
    expect(() => checkDowngrade("0.9.0", "0.10.0", false)).toThrow(/downgrade/i);
  });
  test("refuses an older tag unless forced", () => {
    expect(() => checkDowngrade("0.5.9", "0.6.0", false)).toThrow(/downgrade/i);
    expect(() => checkDowngrade("0.5.9", "0.6.0", true)).not.toThrow();
  });
});

describe("parseVersion", () => {
  test("strips the leading v", () => {
    expect(parseVersion("v0.6.0")).toBe("0.6.0");
    expect(parseVersion("v10.20.30")).toBe("10.20.30");
  });
  test("rejects anything that is not vX.Y.Z", () => {
    for (const bad of ["", "0.6.0", "v0.6", "v0.6.0-rc1", "v0.6.0.1", "studio-v0.1.0", "v-1.0.0", "vx.y.z"]) {
      expect(() => parseVersion(bad)).toThrow();
    }
  });
});

describe("classifyAsset", () => {
  test("recognises the installers by extension", () => {
    expect(classifyAsset("uniquemedia-0.6.0-arm64.dmg")).toBe("mac");
    expect(classifyAsset("uniquemedia.Setup.0.6.0.exe")).toBe("win");
    expect(classifyAsset("UNIQUEMEDIA.EXE")).toBe("win");
  });
  test("ignores everything else", () => {
    expect(classifyAsset("latest.yml")).toBeNull();
    expect(classifyAsset("uniquemedia.dmg.blockmap")).toBeNull();
  });
});

describe("buildLatest", () => {
  test("has exactly the shape the landing page validates", () => {
    const latest = buildLatest({
      version: "0.6.0",
      mac: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/a.dmg",
      win: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/b.exe",
      now: new Date("2026-10-04T12:00:00.000Z"),
    });
    expect(latest).toEqual({
      version: "0.6.0",
      mac: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/a.dmg",
      win: "https://x.public.blob.vercel-storage.com/uniquemedia/0.6.0/b.exe",
      publishedAt: "2026-10-04T12:00:00.000Z",
    });
  });
});


const MB = 1024 * 1024;
const BASE = "https://x.public.blob.vercel-storage.com";
const P = (v: string, f: string) => `uniquemedia/${v}/${f}`;

describe("currentRefsOf", () => {
  test("turns the blob urls of latest.json into store pathnames", () => {
    expect(
      currentRefsOf({
        version: "0.7.0",
        mac: `${BASE}/uniquemedia/0.7.0/a.dmg`,
        win: `${BASE}/uniquemedia/0.7.0/Setup%201.exe`,
        publishedAt: "t",
      }),
    ).toEqual({ version: "0.7.0", mac: "uniquemedia/0.7.0/a.dmg", win: "uniquemedia/0.7.0/Setup 1.exe" });
  });
  test("rejects urls outside uniquemedia/ rather than guessing what to keep", () => {
    expect(() => currentRefsOf({ version: "0.7.0", mac: `${BASE}/other/a.dmg`, win: `${BASE}/uniquemedia/x.exe` })).toThrow();
    expect(() => currentRefsOf({ version: "0.7.0", mac: 1, win: "nope" })).toThrow();
  });
});

describe("planUpload", () => {
  const current = { version: "0.7.0", mac: P("0.7.0", "a.dmg"), win: P("0.7.0", "b.exe") };
  const store = [
    { pathname: current.mac, size: 272 * MB },
    { pathname: current.win, size: 252 * MB },
  ];
  const files = (mac: number, win: number) => [
    { platform: "mac" as const, name: "n.dmg", size: mac },
    { platform: "win" as const, name: "n.exe", size: win },
  ];
  const kinds = (p: Plan) => p.steps.map((s) => s.kind + (s.kind === "upload" ? `:${s.platform}` : ""));

  test("fits alongside the current version: upload all, publish, wait, delete the old version", () => {
    const plan = planUpload({ version: "0.7.1", current, blobs: store, files: files(150 * MB, 140 * MB) });
    expect(plan.mode).toBe("all");
    expect(kinds(plan)).toEqual(["upload:mac", "upload:win", "publish", "wait", "delete"]);
    expect(plan.steps[2]).toEqual({
      kind: "publish",
      version: "0.7.1",
      mac: P("0.7.1", "n.dmg"),
      win: P("0.7.1", "n.exe"),
    });
    expect(plan.steps[4]).toEqual({ kind: "delete", pathnames: [current.mac, current.win] });
    expect(plan.peakBytes).toBe((272 + 252 + 150 + 140) * MB);
  });

  test("the v0.7.1 incident rolls one platform at a time", () => {
    const plan = planUpload({ version: "0.7.1", current, blobs: store, files: files(260 * MB, 218 * MB) });
    expect(plan.mode).toBe("rolling");
    expect(plan.steps).toEqual([
      { kind: "upload", platform: "mac", pathname: P("0.7.1", "n.dmg"), bytes: 260 * MB },
      { kind: "publish", version: "0.7.0", mac: P("0.7.1", "n.dmg"), win: current.win },
      { kind: "wait", seconds: CACHE_WAIT_SECONDS },
      { kind: "delete", pathnames: [current.mac] },
      { kind: "upload", platform: "win", pathname: P("0.7.1", "n.exe"), bytes: 218 * MB },
      { kind: "publish", version: "0.7.1", mac: P("0.7.1", "n.dmg"), win: P("0.7.1", "n.exe") },
      { kind: "wait", seconds: CACHE_WAIT_SECONDS },
      { kind: "delete", pathnames: [current.win] },
    ]);
    // High point is right after the mac upload (272 + 252 + 260); the win upload peaks at 252 + 260 + 218.
    expect(plan.peakBytes).toBe((272 + 252 + 260) * MB);
    expect(plan.peakBytes).toBeLessThanOrEqual(SIZE_LIMIT_BYTES);
  });

  test("the wait outlasts the 60 s cache of latest.json", () => {
    // CDN propagation (up to 60 s) plus the browser max-age (60 s).
    expect(CACHE_WAIT_SECONDS).toBeGreaterThanOrEqual(125);
  });

  test("refuses, touching nothing, when even the rolling peak does not fit", () => {
    const huge = [
      { pathname: current.mac, size: 500 * MB },
      { pathname: current.win, size: 400 * MB },
    ];
    expect(() => planUpload({ version: "0.7.1", current, blobs: huge, files: files(300 * MB, 300 * MB) })).toThrow(/950 MB/);
  });

  test("no current version: uploads and publishes, deletes nothing", () => {
    const plan = planUpload({ version: "0.7.1", current: null, blobs: [], files: files(260 * MB, 218 * MB) });
    expect(kinds(plan)).toEqual(["upload:mac", "upload:win", "publish"]);
    expect(plan.peakBytes).toBe(478 * MB);
  });

  test("no current version and too big: refuses", () => {
    expect(() => planUpload({ version: "0.7.1", current: null, blobs: [], files: files(SIZE_LIMIT_BYTES, 1) })).toThrow(/950 MB/);
  });

  test("exactly the limit fits, one byte over rolls", () => {
    const small = [
      { pathname: current.mac, size: 100 * MB },
      { pathname: current.win, size: 100 * MB },
    ];
    const half = (SIZE_LIMIT_BYTES - 200 * MB) / 2;
    expect(planUpload({ version: "0.7.1", current, blobs: small, files: files(half, half) }).mode).toBe("all");
    expect(planUpload({ version: "0.7.1", current, blobs: small, files: files(half + 1, half) }).mode).toBe("rolling");
  });

  test("stale versions are deleted first, after a wait, and do not count toward the peak", () => {
    const old = { pathname: P("0.6.0", "a.dmg"), size: 400 * MB };
    const plan = planUpload({ version: "0.7.1", current, blobs: [old, ...store], files: files(150 * MB, 140 * MB) });
    expect(plan.steps.slice(0, 2)).toEqual([
      { kind: "wait", seconds: CACHE_WAIT_SECONDS },
      { kind: "delete", pathnames: [old.pathname] },
    ]);
    expect(plan.peakBytes).toBe((272 + 252 + 150 + 140) * MB);
  });

  test("latest.json is never deleted and never counted, in either mode", () => {
    const latest = { pathname: "uniquemedia/latest.json", size: 5 * MB };
    for (const [mac, win] of [[150 * MB, 140 * MB], [260 * MB, 218 * MB]]) {
      const plan = planUpload({ version: "0.7.1", current, blobs: [latest, ...store], files: files(mac, win) });
      expect(plan.steps.some((s) => s.kind === "delete" && s.pathnames.includes(latest.pathname))).toBe(false);
      expect(plan.peakBytes).toBe(planUpload({ version: "0.7.1", current, blobs: store, files: files(mac, win) }).peakBytes);
    }
  });

  test("blobs outside uniquemedia/ are neither deleted nor counted", () => {
    const other = { pathname: "other/keep.bin", size: 900 * MB };
    const plan = planUpload({ version: "0.7.1", current, blobs: [other, ...store], files: files(150 * MB, 140 * MB) });
    expect(plan.steps.some((s) => s.kind === "delete" && s.pathnames.includes(other.pathname))).toBe(false);
    expect(plan.mode).toBe("all");
  });

  test("a leftover at a path the upload overwrites is not garbage; one at another path in the same version is", () => {
    const sameName = { pathname: P("0.7.1", "n.dmg"), size: 10 * MB }; // half-written earlier attempt
    const otherName = { pathname: P("0.7.1", "old-name.dmg"), size: 10 * MB };
    const plan = planUpload({ version: "0.7.1", current, blobs: [sameName, otherName, ...store], files: files(150 * MB, 140 * MB) });
    const deleted = plan.steps.flatMap((s) => (s.kind === "delete" ? s.pathnames : []));
    expect(deleted).toContain(otherName.pathname);
    expect(deleted).not.toContain(sameName.pathname);
  });

  test("the rolling peak may equal the limit but not exceed it", () => {
    const peak = (272 + 252 + 260) * MB;
    expect(planUpload({ version: "0.7.1", current, blobs: store, files: files(260 * MB, 218 * MB), limitBytes: peak }).mode).toBe("rolling");
    expect(() =>
      planUpload({ version: "0.7.1", current, blobs: store, files: files(260 * MB, 218 * MB), limitBytes: peak - 1 }),
    ).toThrow(/over the/);
  });

  test("a file already in the store with the same path and size is not uploaded again", () => {
    const blobs = [{ pathname: P("0.7.1", "n.dmg"), size: 150 * MB }, ...store];
    const plan = planUpload({ version: "0.7.1", current, blobs, files: files(150 * MB, 140 * MB) });
    expect(kinds(plan)).toEqual(["upload:win", "publish", "wait", "delete"]);
    const resized = planUpload({ version: "0.7.1", current, blobs, files: files(151 * MB, 140 * MB) });
    expect(kinds(resized)).toContain("upload:mac");
  });

  test("re-uploading the current version overwrites it and deletes nothing", () => {
    const plan = planUpload({
      version: "0.7.0",
      current,
      blobs: store,
      files: [
        { platform: "mac", name: "a.dmg", size: 272 * MB },
        { platform: "win", name: "b.exe", size: 252 * MB },
      ],
    });
    expect(plan.mode).toBe("all");
    expect(plan.steps.some((s) => s.kind === "delete" || s.kind === "upload")).toBe(false);
    expect(plan.peakBytes).toBe(524 * MB);
  });

  test("a retry after a run died in the mixed state finishes the roll", async () => {
    const mixed = { version: "0.7.0", mac: P("0.7.1", "n.dmg"), win: current.win };
    const blobs = [
      { pathname: "uniquemedia/latest.json", size: 0 },
      { pathname: P("0.7.1", "n.dmg"), size: 260 * MB },
      { pathname: current.win, size: 252 * MB },
    ];
    const plan = planUpload({ version: "0.7.1", current: mixed, blobs, files: files(260 * MB, 218 * MB) });
    expect(plan.steps.at(-1)).toEqual({ kind: "delete", pathnames: [current.win] });
    expect(plan.steps.some((s) => s.kind === "delete" && s.pathnames.includes(P("0.7.1", "n.dmg")))).toBe(false);
    const r = replay(blobs, plan, mixed);
    await executePlan(plan, r.io);
    expect(r.live()).toEqual({ mac: P("0.7.1", "n.dmg"), win: P("0.7.1", "n.exe") });
    expect([...r.store.keys()].sort()).toEqual([P("0.7.1", "n.dmg"), P("0.7.1", "n.exe"), "uniquemedia/latest.json"]);
  });

  test("a mixed publish needs the old installers to exist", () => {
    const blobs = [{ pathname: current.win, size: 700 * MB }];
    expect(() => planUpload({ version: "0.7.1", current, blobs, files: files(260 * MB, 218 * MB) })).toThrow(/not in the store/);
  });
});

/** Replays a plan against a fake store and checks what protects visitors and the quota. */
function replay(blobs: { pathname: string; size: number }[], plan: Plan, current: { mac: string; win: string }, cachedAtStart: { mac: string; win: string }[] = []) {
  const store = new Map(blobs.map((b) => [b.pathname, b.size]));
  const sizes = new Map(plan.steps.flatMap((s) => (s.kind === "upload" ? [[s.pathname, s.bytes] as const] : [])));
  let live = current; // what latest.json says now
  let cached = [...cachedAtStart]; // copies a browser may still hold
  let peak = 0;
  const track = () => {
    peak = Math.max(peak, [...store.values()].reduce((n, v) => n + v, 0));
  };
  const io: PlanIo = {
    upload: async (s) => {
      store.set(s.pathname, sizes.get(s.pathname) as number);
      track();
    },
    publish: async (s) => {
      expect(store.has(s.mac)).toBe(true); // never points at a file that is not there
      expect(store.has(s.win)).toBe(true);
      cached.push(live);
      live = { mac: s.mac, win: s.win };
    },
    remove: async (pathnames) => {
      for (const p of pathnames) {
        expect(p).not.toBe("uniquemedia/latest.json");
        expect([live.mac, live.win]).not.toContain(p); // not referenced by the live latest.json
        expect(cached.some((c) => c.mac === p || c.win === p)).toBe(false); // nor by a copy that may be cached
        store.delete(p);
      }
    },
    sleep: async () => {
      cached = [];
    },
  };
  track();
  return { io, store, peak: () => peak, live: () => live };
}

describe("executePlan", () => {
  const cur = { version: "0.7.0", mac: P("0.7.0", "a.dmg"), win: P("0.7.0", "b.exe") };
  const blobs = [
    { pathname: cur.mac, size: 272 * MB },
    { pathname: cur.win, size: 252 * MB },
  ];
  const cases: [string, number, number][] = [
    ["fits-all", 150 * MB, 140 * MB],
    ["rolling", 260 * MB, 218 * MB],
  ];
  for (const [name, mac, win] of cases) {
    test(`${name}: never a reference to an absent or still-cached file; ends fully new`, async () => {
      const plan = planUpload({
        version: "0.7.1",
        current: cur,
        blobs,
        files: [
          { platform: "mac", name: "n.dmg", size: mac },
          { platform: "win", name: "n.exe", size: win },
        ],
      });
      const r = replay(blobs, plan, cur);
      await executePlan(plan, r.io);
      expect(r.peak()).toBe(plan.peakBytes);
      expect(r.peak()).toBeLessThanOrEqual(SIZE_LIMIT_BYTES);
      expect(r.live()).toEqual({ mac: P("0.7.1", "n.dmg"), win: P("0.7.1", "n.exe") });
      expect([...r.store.keys()].sort()).toEqual([P("0.7.1", "n.dmg"), P("0.7.1", "n.exe")]);
    });
  }

  test("a wait step sleeps for its seconds", async () => {
    const slept: number[] = [];
    const io: PlanIo = {
      upload: async () => {},
      publish: async () => {},
      remove: async () => {},
      sleep: async (ms) => void slept.push(ms),
    };
    await executePlan({ mode: "all", peakBytes: 0, steps: [{ kind: "wait", seconds: 65 }] }, io);
    expect(slept).toEqual([65_000]);
  });

  test("a failing step stops the run: later steps never execute", async () => {
    const calls: string[] = [];
    const io: PlanIo = {
      upload: async () => {
        throw new Error("boom");
      },
      publish: async () => void calls.push("publish"),
      remove: async () => void calls.push("remove"),
      sleep: async () => {},
    };
    const plan = planUpload({
      version: "0.7.1",
      current: null,
      blobs: [],
      files: [
        { platform: "mac", name: "n.dmg", size: 1 },
        { platform: "win", name: "n.exe", size: 1 },
      ],
    });
    await expect(executePlan(plan, io)).rejects.toThrow("boom");
    expect(calls).toEqual([]);
  });
});

describe("garbage deletion on a re-run", () => {
  test("waits first, so a cached latest.json that pointed at the garbage has expired", async () => {
    const cur = { version: "0.7.1", mac: P("0.7.1", "n.dmg"), win: P("0.7.1", "n.exe") };
    const garbage = { pathname: P("0.7.0", "a.dmg"), size: 272 * MB };
    const blobs = [
      garbage,
      { pathname: cur.mac, size: 260 * MB },
      { pathname: cur.win, size: 218 * MB },
    ];
    const plan = planUpload({
      version: "0.7.1",
      current: cur,
      blobs,
      files: [
        { platform: "mac", name: "n.dmg", size: 260 * MB },
        { platform: "win", name: "n.exe", size: 218 * MB },
      ],
    });
    const r = replay(blobs, plan, cur, [{ mac: garbage.pathname, win: P("0.7.0", "b.exe") }]);
    await executePlan(plan, r.io);
    expect(r.store.has(garbage.pathname)).toBe(false);
  });
});

describe("effectiveVersion", () => {
  test("is the label of latest.json when its files belong to it", () => {
    expect(effectiveVersion({ version: "0.7.0", mac: P("0.7.0", "a.dmg"), win: P("0.7.0", "b.exe") })).toBe("0.7.0");
    expect(effectiveVersion(null)).toBeNull();
  });
  test("a mixed latest.json counts as its newest installer, so an older tag cannot roll it back", () => {
    const mixed = { version: "0.7.0", mac: P("0.7.1", "n.dmg"), win: P("0.7.0", "b.exe") };
    expect(effectiveVersion(mixed)).toBe("0.7.1");
    expect(() => checkDowngrade("0.7.0", effectiveVersion(mixed), false)).toThrow(/downgrade/i);
    expect(() => checkDowngrade("0.7.1", effectiveVersion(mixed), false)).not.toThrow();
  });
  test("compares numerically", () => {
    expect(effectiveVersion({ version: "0.9.0", mac: P("0.10.0", "a.dmg"), win: P("0.9.0", "b.exe") })).toBe("0.10.0");
  });
});
