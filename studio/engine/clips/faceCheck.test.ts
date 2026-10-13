import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { ClipFace } from "../../shared/engine";
import { defaultFaceGateConfig } from "../face/config";
import type { FaceVerdict } from "../face/verdict";
import type { WorkerFaceGate } from "../face/worker/workerGate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { checkClipFace, CLIP_FACE_LINE, MIN_FACE_FRAMES, type CheckClipFaceOptions } from "./faceCheck";
import { useClipFixtures } from "./testing/clipFixtures";
import type { sampleFrames } from "./frames";
useNativeGlobals();

// I5.52 and §5.11: the face check MARKS, never decides. It is the p75 (nearest rank) of SFace over one frame every half second against the master embedding taken when the job started,
// and it runs only when the photo itself was judged: the role comes IN as an argument, so a hidden or profile photo makes no worker call at all.

const clip = useClipFixtures();
const MASTER = new Float32Array([1, 0, 0]);

type Answer = FaceVerdict | "throws";
const match = (similarity: number): FaceVerdict => ({ kind: "match", similarity, faces: 1, headRatio: 0.3 });
const mismatch = (similarity: number): FaceVerdict => ({ kind: "mismatch", similarity, faces: 1, headRatio: 0.3 });
const noFace: FaceVerdict = { kind: "no-face", faces: 0 };

interface Seen {
  pose: string;
  bytes: Uint8Array;
  masterEmbedding: Float32Array;
}

/** A worker gate that answers the n-th frame with the n-th answer and remembers what it was asked. The frame's first byte is its index. */
function scriptedGate(answers: readonly Answer[]): { gate: Pick<WorkerFaceGate, "check">; seen: Seen[]; peak: () => number } {
  const seen: Seen[] = [];
  let live = 0;
  let peak = 0;
  return {
    seen,
    peak: () => peak,
    gate: {
      check: async (input) => {
        seen.push({ pose: input.pose, bytes: input.bytes, masterEmbedding: input.masterEmbedding });
        live++;
        peak = Math.max(peak, live);
        await Promise.resolve();
        live--;
        const answer = answers[input.bytes[0] ?? 0];
        if (answer === undefined) throw new Error("the script has no answer for this frame");
        if (answer === "throws") throw new Error("the worker died");
        return answer;
      },
    },
  };
}

/** Frames that are not pictures: the scripted gate reads only their first byte. */
const framesOf =
  (count: number): typeof sampleFrames =>
  async () =>
    Array.from({ length: count }, (_, i) => new Uint8Array([i, 0xff, 0xd8]));

const base = {
  clipPath: "/clips/a.mp4",
  durationMs: 5_000,
  scratchDir: "/clips",
  masterEmbedding: MASTER,
  signal: new AbortController().signal,
  log: (_line: string): void => {},
} as const;

function run(answers: readonly Answer[], more: Partial<CheckClipFaceOptions> = {}, frameCount = answers.length) {
  const world = scriptedGate(answers);
  const lines: string[] = [];
  const result = checkClipFace({ ...base, role: "judged", gate: world.gate, sampleFrames: framesOf(frameCount), log: (line) => lines.push(line), ...more });
  return { result, lines, ...world };
}

const times = <T>(n: number, value: T): T[] => Array.from({ length: n }, () => value);

describe("the line", () => {
  test("is the photo gate's 0.55", () => {
    const strategy = defaultFaceGateConfig().identity.strategy;
    expect(strategy.kind === "fixed-threshold" ? strategy.threshold : null).toBe(CLIP_FACE_LINE);
    expect(CLIP_FACE_LINE).toBe(0.55);
  });
});

describe("checkClipFace p75", () => {
  test("is a match when the p75 of 8 frames with a face is 0.8, though 3 frames have none", async () => {
    // 8 similarities: nearest rank is the ceil(0.75 x 8) = 6th smallest, 0.8.
    const { result } = run([...times(8, match(0.8)), ...times(3, noFace)]);
    expect(await result).toEqual({ verdict: "match", p75: 0.8, frames: 8 });
  });

  test("is a mismatch when 9 of 11 frames are 0.5 and 2 are 0.7", async () => {
    // Nearest rank: the ceil(0.75 x 11) = 9th smallest is 0.5, so the two good frames do not carry the clip.
    const { result } = run([...times(9, mismatch(0.5)), ...times(2, match(0.7))]);
    expect(await result).toEqual({ verdict: "mismatch", p75: 0.5, frames: 11 });
  });

  test("takes the p75 of the sorted similarities whatever order the frames came in", async () => {
    // Sorted: 0.1 0.2 0.3 0.9. Rank ceil(0.75 x 4) = 3, so 0.3.
    const { result } = run([match(0.9), mismatch(0.1), match(0.3), mismatch(0.2)]);
    expect(await result).toEqual({ verdict: "mismatch", p75: 0.3, frames: 4 });
  });

  test("is a match when the p75 is exactly the line", async () => {
    const { result } = run(times(4, match(0.55)));
    expect(await result).toEqual({ verdict: "match", p75: 0.55, frames: 4 });
  });

  test("is a mismatch when the p75 is a hair under the line", async () => {
    const { result } = run(times(4, mismatch(0.5499)));
    expect(await result).toEqual({ verdict: "mismatch", p75: 0.5499, frames: 4 });
  });

  test("counts a frame the gate marked, found no face in, found several in, or called something else as no face", async () => {
    const marked: FaceVerdict = { kind: "marked", similarity: 0.99, faces: 1, headRatio: 0.3 };
    const several: FaceVerdict = { kind: "multiple-faces", faces: 2 };
    const skippedByPose: FaceVerdict = { kind: "skipped-by-pose", faces: 1 };
    const unexpected: FaceVerdict = { kind: "unexpected-face", faces: 2, headRatio: 0.1 };
    // Four frames with a face at 0.3, and four that must not count (their 0.99 would lift the p75 to 0.99 if they did).
    const { result } = run([...times(4, mismatch(0.3)), marked, several, skippedByPose, unexpected]);
    expect(await result).toEqual({ verdict: "mismatch", p75: 0.3, frames: 4 });
  });

  test("counts a verdict of a kind this build does not know as no face", async () => {
    const unknown = { kind: "from-a-later-build", similarity: 0.99, faces: 1 } as unknown as FaceVerdict;
    const { result } = run([...times(3, mismatch(0.3)), unknown]);
    expect(await result).toEqual({ verdict: "mismatch", p75: 0.3, frames: 3 });
  });

  test("counts a similarity that is not a number as no face", async () => {
    const { result } = run([...times(3, mismatch(0.3)), match(Number.NaN)]);
    expect(await result).toEqual({ verdict: "mismatch", p75: 0.3, frames: 3 });
  });

  test("keeps the p75 inside the contract's -1 to 1", async () => {
    const { result } = run(times(3, match(1.0000001)));
    const face = await result;
    expect(face.p75).toBe(1);
    expect(ClipFace.safeParse(face).success).toBe(true);
  });

  test("is skipped as few-faces when only 2 frames have one face", async () => {
    expect(MIN_FACE_FRAMES).toBe(3);
    const { result } = run([match(0.9), match(0.9), noFace, noFace, noFace]);
    expect(await result).toEqual({ verdict: "skipped", frames: 2, why: "few-faces" });
  });

  test("is judged from exactly 3 frames with a face", async () => {
    const { result } = run([match(0.9), match(0.9), match(0.9), noFace]);
    expect(await result).toEqual({ verdict: "match", p75: 0.9, frames: 3 });
  });

  test("is skipped as few-faces when no frame has a face", async () => {
    const { result } = run(times(10, noFace));
    expect(await result).toEqual({ verdict: "skipped", frames: 0, why: "few-faces" });
  });

  test("is skipped as few-faces when no frame could be taken", async () => {
    const { result } = run([], {}, 0);
    expect(await result).toEqual({ verdict: "skipped", frames: 0, why: "few-faces" });
  });

  test("always answers a face the contract accepts", async () => {
    for (const answers of [times(8, match(0.8)), times(4, mismatch(0.1)), times(10, noFace)]) {
      expect(ClipFace.safeParse(await run(answers).result).success).toBe(true);
    }
  });
});

describe("checkClipFace asks the worker", () => {
  test("for every frame, as a front pose, against the master embedding it was given", async () => {
    const world = run(times(6, match(0.9)));
    await world.result;
    expect(world.seen).toHaveLength(6);
    expect(world.seen.every((s) => s.pose === "front")).toBe(true);
    expect(world.seen.every((s) => s.masterEmbedding === MASTER)).toBe(true);
    expect(world.seen.map((s) => s.bytes[0])).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("one frame at a time", async () => {
    const world = run(times(10, match(0.9)));
    await world.result;
    expect(world.peak()).toBe(1);
  });

  test("on the frames of the real clip, when no sampler is given", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5 });
    const seen: Uint8Array[] = [];
    const gate: Pick<WorkerFaceGate, "check"> = {
      check: async (input) => {
        seen.push(input.bytes);
        return match(0.9);
      },
    };
    const face = await checkClipFace({ ...base, role: "judged", clipPath: path, scratchDir: tmpdir(), gate });
    expect(seen.length).toBeGreaterThanOrEqual(10);
    expect(seen.every((bytes) => bytes[0] === 0xff && bytes[1] === 0xd8)).toBe(true);
    expect(face).toEqual({ verdict: "match", p75: 0.9, frames: seen.length });
  });
});

describe("checkClipFace and the role", () => {
  test("makes no worker call and takes no frame for a profile photo, and says why", async () => {
    let sampled = 0;
    const world = run(times(8, match(0.9)), { role: "profile", sampleFrames: async () => (sampled++, []) });
    expect(await world.result).toEqual({ verdict: "skipped", frames: 0, why: "profile" });
    expect(world.seen).toHaveLength(0);
    expect(sampled).toBe(0);
  });

  test("makes no worker call and takes no frame for a hidden-face photo, and says why", async () => {
    let sampled = 0;
    const world = run(times(8, match(0.9)), { role: "hidden", sampleFrames: async () => (sampled++, []) });
    expect(await world.result).toEqual({ verdict: "skipped", frames: 0, why: "hidden" });
    expect(world.seen).toHaveLength(0);
    expect(sampled).toBe(0);
  });

  test("gives a skipped role no p75", async () => {
    const face = await run(times(8, match(0.9)), { role: "hidden" }).result;
    expect(face.p75).toBeUndefined();
    expect(ClipFace.safeParse(face).success).toBe(true);
  });
});

describe("checkClipFace when the machinery breaks", () => {
  test("is skipped as worker, and logged, when the worker dies on a frame", async () => {
    const world = run([match(0.9), match(0.9), "throws", match(0.9)]);
    expect(await world.result).toEqual({ verdict: "skipped", frames: 0, why: "worker" });
    expect(world.lines.length).toBeGreaterThan(0);
  });

  test("asks the worker no more after it died", async () => {
    const world = run([match(0.9), "throws", match(0.9), match(0.9)]);
    await world.result;
    expect(world.seen).toHaveLength(2);
  });

  test("never writes the worker's message into the log line", async () => {
    const lines: string[] = [];
    const gate: Pick<WorkerFaceGate, "check"> = {
      check: async () => {
        throw new Error("secret-token-12345 in the message");
      },
    };
    await checkClipFace({ ...base, role: "judged", gate, sampleFrames: framesOf(3), log: (line) => lines.push(line) });
    expect(lines.join("\n")).not.toContain("secret-token-12345");
  });

  test("is skipped as worker, and logged, when the frames cannot be taken", async () => {
    const lines: string[] = [];
    const world = scriptedGate([]);
    const face = await checkClipFace({
      ...base,
      role: "judged",
      gate: world.gate,
      sampleFrames: async () => {
        throw new Error("ffmpeg exited 1");
      },
      log: (line) => lines.push(line),
    });
    expect(face).toEqual({ verdict: "skipped", frames: 0, why: "worker" });
    expect(lines.length).toBeGreaterThan(0);
    expect(world.seen).toHaveLength(0);
  });

  test("rejects with the signal's reason, not a verdict, when the call is aborted mid-way", async () => {
    const controller = new AbortController();
    const gate: Pick<WorkerFaceGate, "check"> = {
      check: async () => {
        controller.abort(new Error("owner cancelled"));
        throw controller.signal.reason;
      },
    };
    const run = checkClipFace({ ...base, signal: controller.signal, role: "judged", gate, sampleFrames: framesOf(5) });
    await expect(run).rejects.toThrow("owner cancelled");
  });

  test("rejects with the signal's reason when it is already aborted, before any frame is taken", async () => {
    const controller = new AbortController();
    controller.abort(new Error("owner cancelled"));
    let sampled = 0;
    const world = scriptedGate(times(5, match(0.9)));
    const run = checkClipFace({ ...base, signal: controller.signal, role: "judged", gate: world.gate, sampleFrames: async () => (sampled++, []) });
    await expect(run).rejects.toThrow("owner cancelled");
    expect(sampled).toBe(0);
    expect(world.seen).toHaveLength(0);
  });
});
