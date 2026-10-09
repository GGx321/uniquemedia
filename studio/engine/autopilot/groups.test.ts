import { describe, expect, test } from "bun:test";
import { LaunchGroups } from "./groups";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.2 (plan §4.10): the registry the engine's `groupOf` reads. An attempt whose id starts with `<launchSetId>:writer-` (the compose and the launch's own
// «Дописать»), or whose scope is `{ runId }` of a launch slice, belongs to `launch:<launchId>` with cap W′. Review writes (`<setId>:write-*`) do not. A launch
// that is finished maps nothing.

const W = 1_000_000;

function registry(): LaunchGroups {
  const groups = new LaunchGroups();
  groups.register({ launchId: "L1", capMicros: W, setIds: ["set-aaa", "set-bbb"], runIds: ["run-slice-1"] });
  return groups;
}

describe("groupOf", () => {
  test("a writer attempt of a launch set belongs to the launch's group with cap W′", () => {
    expect(registry().groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "set-aaa-run" } })).toEqual({ key: "launch:L1", capMicros: W });
  });

  test("every set of the launch maps to the same group", () => {
    const groups = registry();
    expect(groups.groupOf({ attemptId: "set-bbb:writer-3#2", scope: { runId: "x" } })?.key).toBe("launch:L1");
  });

  test("an attempt of a registered slice run belongs to the group, whatever its id", () => {
    expect(registry().groupOf({ attemptId: "run-slice-1:slot-4#2", scope: { runId: "run-slice-1" } })).toEqual({ key: "launch:L1", capMicros: W });
  });

  test("a review write (<setId>:write-k) is outside the group, even on a launch set", () => {
    expect(registry().groupOf({ attemptId: "set-aaa:write-1#1", scope: { runId: "set-aaa-review" } })).toBeNull();
  });

  test("a manual run's attempt is outside the group", () => {
    expect(registry().groupOf({ attemptId: "run-manual:slot-1#1", scope: { runId: "run-manual" } })).toBeNull();
  });

  test("an avatar job's attempt is outside the group", () => {
    expect(registry().groupOf({ attemptId: "job-1:describe#1", scope: { avatarJobId: "job-1" } })).toBeNull();
  });

  test("a set id that only starts like a launch set's is not matched", () => {
    expect(registry().groupOf({ attemptId: "set-aaa-2:writer-1#1", scope: { runId: "r" } })).toBeNull();
    expect(registry().groupOf({ attemptId: "set-aa:writer-1#1", scope: { runId: "r" } })).toBeNull();
  });

  test("an unregistered launch maps nothing", () => {
    expect(new LaunchGroups().groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "r" } })).toBeNull();
  });
});

describe("registering before the first reserve, and growing", () => {
  test("a slice run added later joins the group", () => {
    const groups = registry();
    expect(groups.groupOf({ attemptId: "s:slot-1#1", scope: { runId: "run-slice-2" } })).toBeNull();
    groups.addRun("L1", "run-slice-2");
    expect(groups.groupOf({ attemptId: "s:slot-1#1", scope: { runId: "run-slice-2" } })?.key).toBe("launch:L1");
  });

  test("a set added later joins the group", () => {
    const groups = registry();
    groups.addSet("L1", "set-ccc");
    expect(groups.groupOf({ attemptId: "set-ccc:writer-1#1", scope: { runId: "r" } })?.capMicros).toBe(W);
  });

  test("adding to a launch that is not registered is refused", () => {
    expect(() => new LaunchGroups().addRun("nope", "run-1")).toThrow(/launch nope is not registered/);
    expect(() => new LaunchGroups().addSet("nope", "set-1")).toThrow(/launch nope is not registered/);
  });

  test("registering the same launch again replaces its cap and members, never doubles them", () => {
    const groups = registry();
    groups.register({ launchId: "L1", capMicros: 500_000, setIds: ["set-aaa"], runIds: [] });
    expect(groups.groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "r" } })?.capMicros).toBe(500_000);
    expect(groups.groupOf({ attemptId: "set-bbb:writer-1#1", scope: { runId: "r" } })).toBeNull();
  });

  test("a cap of zero is a valid group (a free launch), and a cap that is not whole micro-dollars is refused", () => {
    const groups = new LaunchGroups();
    groups.register({ launchId: "L0", capMicros: 0, setIds: ["set-zzz"], runIds: [] });
    expect(groups.groupOf({ attemptId: "set-zzz:writer-1#1", scope: { runId: "r" } })?.capMicros).toBe(0);
    expect(() => groups.register({ launchId: "L2", capMicros: 1.5, setIds: [], runIds: [] })).toThrow(TypeError);
    expect(() => groups.register({ launchId: "L2", capMicros: -1, setIds: [], runIds: [] })).toThrow(TypeError);
  });
});

describe("a finished launch", () => {
  test("maps nothing after finish", () => {
    const groups = registry();
    groups.finish("L1");
    expect(groups.groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "r" } })).toBeNull();
    expect(groups.groupOf({ attemptId: "s:slot-1#1", scope: { runId: "run-slice-1" } })).toBeNull();
  });

  test("finishing an unknown launch is harmless", () => {
    expect(() => new LaunchGroups().finish("nope")).not.toThrow();
  });

  test("a finished launch can be registered again (restore after an unfinish is the file's decision, not the registry's)", () => {
    const groups = registry();
    groups.finish("L1");
    groups.register({ launchId: "L1", capMicros: W, setIds: ["set-aaa"], runIds: [] });
    expect(groups.groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "r" } })?.key).toBe("launch:L1");
  });
});

describe("restore from the launch files", () => {
  test("restores every unfinished launch and skips the finished ones", () => {
    const groups = new LaunchGroups();
    groups.restore([
      { launchId: "L1", capMicros: W, setIds: ["set-aaa"], runIds: ["run-1"], finished: false },
      { launchId: "L2", capMicros: 5, setIds: ["set-old"], runIds: ["run-old"], finished: true },
    ]);
    expect(groups.groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "r" } })?.key).toBe("launch:L1");
    expect(groups.groupOf({ attemptId: "x#1", scope: { runId: "run-1" } })?.key).toBe("launch:L1");
    expect(groups.groupOf({ attemptId: "set-old:writer-1#1", scope: { runId: "r" } })).toBeNull();
    expect(groups.groupOf({ attemptId: "x#1", scope: { runId: "run-old" } })).toBeNull();
  });

  test("restoring replaces what was registered before", () => {
    const groups = registry();
    groups.restore([]);
    expect(groups.groupOf({ attemptId: "set-aaa:writer-1#1", scope: { runId: "r" } })).toBeNull();
  });
});
