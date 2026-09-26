import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGE_QUESTION, AGE_SYSTEM, ageJsonSchema } from "../engine/avatars/ageCheck";
import { AGE_CHECK_CALL } from "../engine/money/estimate";
import { FALLBACK_PRICES_DATE } from "../engine/money/prices";
import {
  ageCheckRequestBody,
  checkOneImage,
  checkRefusal,
  listImages,
  parseArgs,
  planFor,
  toCsv,
  type AgeGateFetch,
  type AgeGateRow,
  type Plan,
} from "./ageGateRunner";

// No test here ever calls the network: every fetch is an injected fake
// (bun --no-env-file test never lets a real OPENROUTER_API_KEY through, and
// none of these tests reads process.env at all).

/** A real, valid 1x1 PNG (the same fixture studio/scripts/smoke-engine.ts uses), so the real downscale/ffmpeg pipeline runs unmocked — only the HTTP call is faked. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function withPngFile(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "age-gate-runner-"));
  try {
    const path = join(dir, "candidate.png");
    await writeFile(path, PNG);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A `POST /chat/completions`-shaped 200 response with this message content. */
function fetchAnswering(content: string | null, status = 200): AgeGateFetch {
  return async () => ({
    status,
    json: async () => ({ id: "gen-1", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] }),
  });
}

function answer(adult: unknown, confidence: unknown, reason = "Mature adult features."): string {
  return JSON.stringify({ adult, confidence, reason });
}

describe("ageCheckRequestBody", () => {
  const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);

  test("uses the engine's own model, schema and call shape", () => {
    const body = ageCheckRequestBody(JPEG) as Record<string, unknown>;
    expect(body.model).toBe(AGE_CHECK_CALL.model);
    expect(body.max_tokens).toBe(AGE_CHECK_CALL.maxTokens);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.usage).toEqual({ include: true });
    const responseFormat = body.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: unknown } };
    expect(responseFormat.type).toBe("json_schema");
    expect(responseFormat.json_schema.strict).toBe(true);
    expect(responseFormat.json_schema.name).toBe(ageJsonSchema().name);
    expect(responseFormat.json_schema.schema).toEqual(ageJsonSchema().schema);
  });

  test("sends the system line verbatim and attaches the image to the question", () => {
    const body = ageCheckRequestBody(JPEG) as { messages: { role: string; content: unknown }[] };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: AGE_SYSTEM });
    const userContent = body.messages[1]?.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(userContent[0]).toEqual({ type: "text", text: AGE_QUESTION });
    expect(userContent[1]?.type).toBe("image_url");
    expect(userContent[1]?.image_url?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  test("a fresh call does not share its schema object with the next one", () => {
    const first = ageCheckRequestBody(JPEG).response_format as { json_schema: { schema: Record<string, unknown> } };
    Object.assign(first.json_schema.schema, { properties: { confidence: { type: "number", description: "tampered" } } });
    const second = ageCheckRequestBody(JPEG).response_format as { json_schema: { schema: unknown } };
    expect(second.json_schema.schema).toEqual(ageJsonSchema().schema);
  });
});

describe("parseArgs", () => {
  test("requires a folder", () => {
    expect(() => parseArgs([])).toThrow(/folder is required/);
  });

  test("--help needs no folder", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("defaults: max 50, yes false, dryRun false, no csv", () => {
    const opts = parseArgs(["/tmp/pics"]);
    expect(opts).toEqual({ folder: "/tmp/pics", yes: false, max: 50, dryRun: false, csvPath: null, help: false });
  });

  test("parses every flag", () => {
    const opts = parseArgs(["/tmp/pics", "--yes", "--max", "5", "--dry-run", "--csv", "out.csv"]);
    expect(opts).toEqual({ folder: "/tmp/pics", yes: true, max: 5, dryRun: true, csvPath: "out.csv", help: false });
  });

  test("rejects a non-integer --max", () => {
    expect(() => parseArgs(["/tmp/pics", "--max", "abc"])).toThrow(/--max must be a positive integer/);
  });

  test("rejects a zero or negative --max", () => {
    expect(() => parseArgs(["/tmp/pics", "--max", "0"])).toThrow(/--max must be a positive integer/);
  });

  test("rejects --csv with no path", () => {
    expect(() => parseArgs(["/tmp/pics", "--csv"])).toThrow(/--csv needs a path/);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseArgs(["/tmp/pics", "--bogus"])).toThrow(/unknown or unexpected argument/);
  });

  test("rejects a second positional argument", () => {
    expect(() => parseArgs(["/tmp/pics", "/tmp/more"])).toThrow(/unknown or unexpected argument/);
  });
});

describe("checkRefusal", () => {
  function plan(count: number): Plan {
    return {
      folder: "/tmp/pics",
      images: Array.from({ length: count }, (_, i) => `img${i}.png`),
      worstMicrosPerImage: 5_250,
      worstMicrosTotal: 5_250 * count,
      fallbackDate: FALLBACK_PRICES_DATE,
    };
  }

  test("refuses over --max regardless of the key or --yes", () => {
    expect(checkRefusal(plan(51), { yes: true, max: 50 }, "sk-real")).toEqual({ reason: "OVER_MAX", count: 51, max: 50 });
  });

  test("refuses without a key even with --yes and within --max", () => {
    expect(checkRefusal(plan(5), { yes: true, max: 50 }, undefined)).toEqual({ reason: "NO_KEY" });
  });

  test("refuses on a blank key", () => {
    expect(checkRefusal(plan(5), { yes: true, max: 50 }, "   ")).toEqual({ reason: "NO_KEY" });
  });

  test("refuses without --yes even with a key", () => {
    expect(checkRefusal(plan(5), { yes: false, max: 50 }, "sk-real")).toEqual({ reason: "NO_YES" });
  });

  test("allows when within --max, a key is set, and --yes is given", () => {
    expect(checkRefusal(plan(5), { yes: true, max: 50 }, "sk-real")).toBeNull();
  });

  test("exactly at --max is allowed", () => {
    expect(checkRefusal(plan(50), { yes: true, max: 50 }, "sk-real")).toBeNull();
  });
});

describe("planFor", () => {
  test("prices the age check worst case from the engine's own fallback table: $0.00525 per image (money/estimate.ts's own figure)", () => {
    const plan = planFor("/tmp/pics", ["a.png", "b.png"]);
    expect(plan.worstMicrosPerImage).toBe(5_250);
    expect(plan.worstMicrosTotal).toBe(10_500);
    expect(plan.images).toEqual(["a.png", "b.png"]);
  });

  test("carries the fallback table's own date, so the owner can see how old the price is", () => {
    expect(planFor("/tmp/pics", ["a.png"]).fallbackDate).toBe(FALLBACK_PRICES_DATE);
  });

  test("an empty folder prices to zero", () => {
    expect(planFor("/tmp/pics", []).worstMicrosTotal).toBe(0);
  });
});

describe("listImages", () => {
  test("lists only image files, sorted, ignoring case and other extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-gate-runner-list-"));
    try {
      await writeFile(join(dir, "b.png"), PNG);
      await writeFile(join(dir, "a.JPG"), PNG);
      await writeFile(join(dir, "notes.txt"), "not an image");
      await writeFile(join(dir, "c.webp"), PNG);
      expect(await listImages(dir)).toEqual(["a.JPG", "b.png", "c.webp"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checkOneImage", () => {
  test("a clear adult answer passes, and the raw fields are kept for sorting", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(answer(true, 0.95, "Mature adult features of a woman in her mid-20s.")), "sk-fake", path);
      expect(row).toMatchObject({ adult: true, confidence: 0.95, verdict: "pass" });
      expect(row.file).toBe("candidate.png");
    });
  });

  test("adult:false fails as not-adult", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(answer(false, 0.95)), "sk-fake", path);
      expect(row.verdict).toBe("not-adult");
      expect(row.adult).toBe(false);
    });
  });

  test("low confidence fails as low-confidence", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(answer(true, 0.5)), "sk-fake", path);
      expect(row.verdict).toBe("low-confidence");
      expect(row.confidence).toBe(0.5);
    });
  });

  test("a reason voicing doubt fails as doubt-in-reason, using the engine's own reason heuristics", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(answer(true, 0.95, "She looks about 16 years old.")), "sk-fake", path);
      expect(row.verdict).toBe("doubt-in-reason");
    });
  });

  test("a confidence given as a 0-100 percentage is read the same way the engine does", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(answer(true, 90)), "sk-fake", path);
      expect(row.confidence).toBe(0.9);
      expect(row.verdict).toBe("pass");
    });
  });

  test("malformed JSON content is unreadable", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering("not json at all"), "sk-fake", path);
      expect(row.verdict).toBe("unreadable");
      expect(row.adult).toBeNull();
      expect(row.confidence).toBeNull();
    });
  });

  test("a response with no choices is unreadable", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => ({ status: 200, json: async () => ({ choices: [] }) });
      const row = await checkOneImage(fetchFn, "sk-fake", path);
      expect(row.verdict).toBe("unreadable");
    });
  });

  test("a 401 is reported as a request failure with the status in its detail", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => ({ status: 401, json: async () => ({ error: { message: "invalid API key" } }) });
      const row = await checkOneImage(fetchFn, "sk-fake", path);
      expect(row.verdict).toBe("request-failed");
      expect(row.detail).toContain("401");
    });
  });

  test("a network exception is a request failure", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => {
        throw new Error("connection refused");
      };
      const row = await checkOneImage(fetchFn, "sk-fake", path);
      expect(row.verdict).toBe("request-failed");
      expect(row.detail).toContain("connection refused");
    });
  });

  test("an unreadable image path fails as read-failed, without any request", async () => {
    let called = false;
    const fetchFn: AgeGateFetch = async () => {
      called = true;
      return { status: 200, json: async () => ({}) };
    };
    const row = await checkOneImage(fetchFn, "sk-fake", "/does/not/exist.png");
    expect(row.verdict).toBe("read-failed");
    expect(called).toBe(false);
  });

  test("sends exactly Bearer <the key> in the Authorization header, and JSON content type", async () => {
    await withPngFile(async (path) => {
      let seenAuth: string | undefined;
      let seenContentType: string | undefined;
      const fetchFn: AgeGateFetch = async (_url, init) => {
        seenAuth = init.headers.Authorization;
        seenContentType = init.headers["Content-Type"];
        return { status: 200, json: async () => ({ choices: [{ message: { content: answer(true, 0.95) } }] }) };
      };
      await checkOneImage(fetchFn, "sk-or-v1-the-fake-key", path);
      expect(seenAuth).toBe("Bearer sk-or-v1-the-fake-key");
      expect(seenContentType).toBe("application/json");
    });
  });

  test("posts to the OpenRouter chat completions endpoint", async () => {
    await withPngFile(async (path) => {
      let seenUrl: string | undefined;
      const fetchFn: AgeGateFetch = async (url) => {
        seenUrl = url;
        return { status: 200, json: async () => ({ choices: [{ message: { content: answer(true, 0.95) } }] }) };
      };
      await checkOneImage(fetchFn, "sk-fake", path);
      expect(seenUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    });
  });

  test("empty message content is empty-answer, mirroring candidateJob.ts's EMPTY_CONTENT slot outcome", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(""), "sk-fake", path);
      expect(row.verdict).toBe("empty-answer");
      expect(row.adult).toBeNull();
    });
  });

  test("null message content is empty-answer too", async () => {
    await withPngFile(async (path) => {
      const row = await checkOneImage(fetchAnswering(null), "sk-fake", path);
      expect(row.verdict).toBe("empty-answer");
    });
  });

  test("a 400 moderation refusal is age-check-refused, mirroring candidateJob.ts:278's slot outcome", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => ({
        status: 400,
        json: async () => ({ error: { message: "xAI blocked this request through content moderation." } }),
      });
      const row = await checkOneImage(fetchFn, "sk-fake", path);
      expect(row.verdict).toBe("age-check-refused");
    });
  });

  test("a provider moderation code (metadata.raw) is also age-check-refused", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => ({
        status: 422,
        json: async () => ({ error: { message: "unusable", metadata: { raw: "InputImageSensitiveContentDetected" } } }),
      });
      const row = await checkOneImage(fetchFn, "sk-fake", path);
      expect(row.verdict).toBe("age-check-refused");
    });
  });

  test("a 400 that does not read as a moderation refusal stays request-failed", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => ({ status: 400, json: async () => ({ error: { message: "invalid request body" } }) });
      const row = await checkOneImage(fetchFn, "sk-fake", path);
      expect(row.verdict).toBe("request-failed");
    });
  });

  test("a request-failure detail is redacted before it comes back: the key is never echoed", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => ({
        status: 401,
        json: async () => ({ error: { message: "No auth credentials found for Bearer sk-or-v1-the-fake-key" } }),
      });
      const row = await checkOneImage(fetchFn, "sk-or-v1-the-fake-key", path);
      expect(row.verdict).toBe("request-failed");
      expect(row.detail).not.toContain("sk-or-v1-the-fake-key");
      expect(row.detail).toContain("[redacted]");
    });
  });

  test("a network exception's detail is redacted too", async () => {
    await withPngFile(async (path) => {
      const fetchFn: AgeGateFetch = async () => {
        throw new Error("fetch failed while sending Bearer sk-or-v1-the-fake-key");
      };
      const row = await checkOneImage(fetchFn, "sk-or-v1-the-fake-key", path);
      expect(row.verdict).toBe("request-failed");
      expect(row.detail).not.toContain("sk-or-v1-the-fake-key");
    });
  });

  test("downscaling past its own timeout fails as read-failed, without any request, and is never retried", async () => {
    await withPngFile(async (path) => {
      let called = false;
      const fetchFn: AgeGateFetch = async () => {
        called = true;
        return { status: 200, json: async () => ({}) };
      };
      const row = await checkOneImage(fetchFn, "sk-fake", path, { prepareMs: 1, requestMs: 30_000 });
      expect(row.verdict).toBe("read-failed");
      expect(called).toBe(false);
    });
  });

  test(
    "a request past its own timeout fails as request-failed and is never retried",
    async () => {
      await withPngFile(async (path) => {
        let calls = 0;
        const fetchFn: AgeGateFetch = (_url, init) =>
          new Promise((_resolve, reject) => {
            calls++;
            init.signal.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
          });
        const row = await checkOneImage(fetchFn, "sk-fake", path, { prepareMs: 30_000, requestMs: 50 });
        expect(row.verdict).toBe("request-failed");
        expect(calls).toBe(1);
      });
    },
    5_000,
  );
});

describe("toCsv", () => {
  test("writes a header and one row per image, quoting commas in the reason", () => {
    const rows: AgeGateRow[] = [
      { file: "a.png", adult: true, confidence: 0.95, reason: "Mature, adult, confident.", verdict: "pass" },
      { file: "b.png", adult: false, confidence: 0.9, reason: null, verdict: "not-adult" },
      { file: "c.png", adult: null, confidence: null, reason: null, verdict: "read-failed", detail: "ffmpeg exited with code 1" },
    ];
    const csv = toCsv(rows);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("file,adult,confidence,reason,verdict,detail");
    expect(lines[1]).toBe('a.png,true,0.95,"Mature, adult, confident.",pass,');
    expect(lines[2]).toBe("b.png,false,0.9,,not-adult,");
    expect(lines[3]).toBe("c.png,,,,read-failed,ffmpeg exited with code 1");
  });

  test("round-trips through a real file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "age-gate-runner-csv-"));
    try {
      const path = join(dir, "out.csv");
      const rows: AgeGateRow[] = [{ file: "a.png", adult: true, confidence: 0.8, reason: "ok", verdict: "pass" }];
      await writeFile(path, toCsv(rows), "utf8");
      expect(await readFile(path, "utf8")).toContain("a.png,true,0.8,ok,pass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
