import { afterEach, describe, expect, test } from "bun:test";
import { configureFfmpegEnv, configuredFfmpegEnv } from "./ffmpegEnv";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

afterEach(() => configureFfmpegEnv(undefined));

describe("the environment every ffmpeg child gets", () => {
  test("is not configured until the process entry says so", () => {
    expect(configuredFfmpegEnv()).toBeUndefined();
  });

  test("keeps only the allowlisted variables of what it is given, never a secret", () => {
    configureFfmpegEnv({ PATH: "/usr/bin", SystemRoot: "C:\\Windows", OPENROUTER_API_KEY: "sk-secret", NODE_OPTIONS: "--inspect" });

    expect(configuredFfmpegEnv()).toEqual({ PATH: "/usr/bin", SystemRoot: "C:\\Windows" });
  });

  test("is a copy: changing the object that was given changes nothing", () => {
    const given: Record<string, string> = { PATH: "/usr/bin" };
    configureFfmpegEnv(given);
    given.PATH = "/evil";

    expect(configuredFfmpegEnv()).toEqual({ PATH: "/usr/bin" });
  });

  test("can be cleared", () => {
    configureFfmpegEnv({ PATH: "/usr/bin" });
    configureFfmpegEnv(undefined);

    expect(configuredFfmpegEnv()).toBeUndefined();
  });
});
