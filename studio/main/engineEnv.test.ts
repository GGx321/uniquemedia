import { expect, test } from "bun:test";
import { engineEnv } from "./engineEnv";

test("OPENROUTER_* never reaches the engine, in any letter case", () => {
  const env = engineEnv({
    PATH: "/usr/bin",
    OPENROUTER_API_KEY: "sk-or-v1-secret",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9",
    openrouter_api_key: "sk-or-v1-secret-lower",
    OpenRouter_Api_Key: "sk-or-v1-secret-mixed",
  });
  expect(Object.keys(env).filter((k) => k.toUpperCase().startsWith("OPENROUTER"))).toEqual([]);
  expect(JSON.stringify(env)).not.toContain("sk-or-");
});

test("only allowlisted variables pass: other secrets, NODE_OPTIONS and ELECTRON_* are dropped", () => {
  const env = engineEnv({
    PATH: "/usr/bin",
    HOME: "/Users/me",
    TMPDIR: "/tmp/x",
    LANG: "en_US.UTF-8",
    AWS_SECRET_ACCESS_KEY: "aws",
    GITHUB_TOKEN: "gh",
    NODE_OPTIONS: "--require /tmp/evil.js",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_RENDERER_URL: "http://localhost:5173",
  });
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", TMPDIR: "/tmp/x", LANG: "en_US.UTF-8" });
});

test("Windows names match case-insensitively and keep their spelling", () => {
  const env = engineEnv({ SystemRoot: "C:\\Windows", Path: "C:\\bin", windir: "C:\\Windows", LOCALAPPDATA: "C:\\L" });
  expect(env).toEqual({ SystemRoot: "C:\\Windows", Path: "C:\\bin", windir: "C:\\Windows", LOCALAPPDATA: "C:\\L" });
});

test("undefined values and an empty parent give an empty environment", () => {
  expect(engineEnv({ PATH: undefined })).toEqual({});
  expect(engineEnv({})).toEqual({});
});
