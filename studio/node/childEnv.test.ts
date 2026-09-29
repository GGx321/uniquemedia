import { describe, expect, test } from "bun:test";
import { engineEnv } from "../main/engineEnv";
import { allowlistedEnv, ENV_ALLOWLIST } from "./childEnv";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

describe("allowlistedEnv", () => {
  test("keeps the variables ffmpeg needs to find its temp folder and libraries", () => {
    const env = allowlistedEnv({ PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "C" });

    expect(env).toEqual({ PATH: "/usr/bin", TMPDIR: "/tmp", LANG: "C" });
  });

  test("drops secrets and unlisted variables", () => {
    const env = allowlistedEnv({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-secret", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1" });

    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  test("matches names case-insensitively and keeps the original spelling, as Windows spells them", () => {
    const env = allowlistedEnv({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", Temp: "C:\\Temp", WINDIR: "C:\\Windows" });

    expect(env).toEqual({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", Temp: "C:\\Temp", WINDIR: "C:\\Windows" });
  });

  test("skips a variable whose value is undefined", () => {
    expect(allowlistedEnv({ PATH: undefined, HOME: "/home/a" })).toEqual({ HOME: "/home/a" });
  });

  test("is the very allowlist the engine's own environment uses", () => {
    const parent: Record<string, string> = { ...Object.fromEntries([...ENV_ALLOWLIST].map((name) => [name, "v"])), SECRET_TOKEN: "x" };

    expect(allowlistedEnv(parent)).toEqual(engineEnv(parent));
  });
});
