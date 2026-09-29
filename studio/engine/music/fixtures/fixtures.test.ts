import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { ffmpegPath } from "../../../node/ffmpegBinary";
import { probeJson, runBinary } from "../../render/ffmpeg.testkit";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { musicLists, musicTracks, type MusicListFixture, type MusicTrackFixture } from "./index";
useNativeGlobals();

// Lenient on purpose, like the 3c.3 schema will be: only `id` is required.
const ListSchema = z.looseObject({
  fetchedAt: z.string(),
  response: z.looseObject({
    alacorn_session_id: z.string().optional(),
    items: z.array(
      z.looseObject({
        track: z.looseObject({
          id: z.string(),
          ig_username: z.string().optional(),
          artist_id: z.string().optional(),
          is_explicit: z.boolean().optional(),
          highlight_start_times_in_ms: z.array(z.number()).optional(),
          progressive_download_url: z.string().optional(),
          dash_manifest: z.string().optional(),
        }),
        metadata: z.looseObject({ is_trending_in_clips: z.boolean().optional() }),
      }),
    ),
  }),
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const readList = (f: MusicListFixture) => ListSchema.parse(JSON.parse(readFileSync(f.file, "utf8")));
const allFixtures: readonly (MusicListFixture | MusicTrackFixture)[] = [...Object.values(musicLists), ...Object.values(musicTracks)];

/** True peak (dBTP) and integrated loudness (LUFS) of a whole file, from ffmpeg's ebur128 summary. */
async function measure(file: string): Promise<{ truePeak: number; lufs: number }> {
  const r = await runBinary(ffmpegPath(), ["-nostats", "-hide_banner", "-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]);
  expect(r.code).toBe(0);
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const peak = /Peak:\s*(-?[\d.]+) dBFS/.exec(summary)?.[1];
  const lufs = /I:\s*(-?[\d.]+) LUFS/.exec(summary)?.[1];
  if (peak === undefined || lufs === undefined) throw new Error(`no ebur128 summary in: ${summary}`);
  return { truePeak: Number(peak), lufs: Number(lufs) };
}

const gainFor = (truePeak: number): number => Math.min(0, -1.5 - truePeak);

describe("music fixtures: files", () => {
  test.each(allFixtures.map((f) => [f.file.slice(f.file.indexOf("/fixtures/") + 10), f] as const))("%s exists with its pinned size and sha256", (_name, f) => {
    expect(statSync(f.file).size).toBe(f.bytes);
    expect(sha256(readFileSync(f.file))).toBe(f.sha256);
  });

  test("the committed set stays small (under 1 MB of audio, under 500 KB of JSON)", () => {
    const sum = (fs: readonly { bytes: number }[]): number => fs.reduce((n, f) => n + f.bytes, 0);
    expect(sum(Object.values(musicTracks))).toBeLessThan(1_000_000);
    expect(sum(Object.values(musicLists))).toBeLessThan(500_000);
  });
});

describe("music fixtures: lists", () => {
  test.each(Object.entries(musicLists))("%s parses leniently and matches its index entry", (_name, f) => {
    const list = readList(f);
    expect(list.fetchedAt).toBe(f.fetchedAt);
    expect(list.response.items).toHaveLength(f.itemCount);
    expect(new Set(list.response.items.map((i) => i.track.id)).size).toBe(f.itemCount);
  });

  test("the 7 items lacking ig_username also lack artist_id, and nothing else does", () => {
    const missing = Object.values(musicLists).map((f) => {
      const ids = readList(f)
        .response.items.filter((i) => i.track.ig_username === undefined)
        .map((i) => i.track.id);
      const noArtist = readList(f)
        .response.items.filter((i) => i.track.artist_id === undefined)
        .map((i) => i.track.id);
      expect(noArtist).toEqual(ids);
      expect(ids).toEqual([...f.withoutIgUsername]);
      return ids;
    });
    expect(missing.flat()).toHaveLength(7);
  });

  test("explicit tracks are present (about 30%) and the flag is a real boolean", () => {
    for (const f of Object.values(musicLists)) {
      const items = readList(f).response.items;
      expect(items.filter((i) => i.track.is_explicit === true)).toHaveLength(f.explicitCount);
      expect(f.explicitCount).toBeGreaterThan(0);
    }
  });

  test("highlights arrive unsorted in some items, and 1500 appears", () => {
    for (const f of Object.values(musicLists)) {
      const highlights = readList(f).response.items.flatMap((i) => i.track.highlight_start_times_in_ms ?? []);
      const unsorted = readList(f).response.items.filter((i) => {
        const h = i.track.highlight_start_times_in_ms ?? [];
        return h.some((v, k) => k > 0 && v < (h[k - 1] ?? 0));
      });
      expect(unsorted.length).toBeGreaterThan(0);
      expect(highlights).toContain(1500);
    }
  });

  test("no item is trending in clips (the flag is never used as a filter)", () => {
    for (const f of Object.values(musicLists)) {
      expect(readList(f).response.items.some((i) => i.metadata.is_trending_in_clips === true)).toBe(false);
    }
  });

  test("every progressive_download_url is https on the host(s) the index names, from the two CDN patterns", () => {
    for (const f of Object.values(musicLists)) {
      const hosts = new Set(readList(f).response.items.map((i) => new URL(i.track.progressive_download_url ?? "").host));
      expect([...hosts].sort()).toEqual([...f.downloadHosts].sort());
      for (const h of hosts) expect(/^instagram\.[a-z0-9-]+\.fna\.fbcdn\.net$|^scontent-[a-z0-9-]+\.cdninstagram\.com$/.test(h)).toBe(true);
    }
    for (const f of Object.values(musicLists)) {
      for (const i of readList(f).response.items) {
        expect(new URL(i.track.progressive_download_url ?? "").protocol).toBe("https:");
        expect(i.track.dash_manifest).toBeDefined();
      }
    }
  });

  test("the signed URLs still carry oh= and oe= (kept on purpose; they expired 104-108 h after the capture)", () => {
    for (const f of Object.values(musicLists)) {
      const url = new URL(readList(f).response.items[0]?.track.progressive_download_url ?? "");
      expect(url.searchParams.get("oh")).not.toBeNull();
      expect(url.searchParams.get("oe")).toMatch(/^[0-9A-Fa-f]+$/);
    }
  });

  test("no secret is committed: no RapidAPI header or key, and the session id is redacted", () => {
    for (const f of Object.values(musicLists)) {
      const text = readFileSync(f.file, "utf8");
      expect(text).not.toMatch(/x-rapidapi|rapidapi|api[_-]?key|authorization|bearer/i);
      expect(readList(f).response.alacorn_session_id).toBe("REDACTED");
    }
  });
});

describe("music fixtures: tracks", () => {
  test.each(Object.entries(musicTracks))("%s is HE-AAC stereo at its indexed sample rate and length", async (_name, f) => {
    const probed = await probeJson(f.file, ["-show_entries", "stream=codec_name,profile,sample_rate,channels,duration:format=duration"]);
    const stream = probed.streams[0];
    expect(probed.streams).toHaveLength(1);
    expect(stream?.codec_name).toBe("aac");
    expect(stream?.profile).toBe("HE-AAC");
    expect(stream?.channels).toBe(2);
    expect(Number(stream?.sample_rate)).toBe(f.sampleRate);
    expect(Math.abs(Number(stream?.duration) * 1000 - f.durationMs)).toBeLessThan(15);
    expect(probed.format.tags?.title).toBeUndefined();
    expect(probed.format.tags?.artist).toBeUndefined();
  });

  test.each(Object.entries(musicTracks))("%s keeps its measured true peak and comes from a track in a list", async (_name, f) => {
    const { truePeak, lufs } = await measure(f.file);
    expect(Math.abs(truePeak - f.truePeakDbtp)).toBeLessThan(0.051);
    expect(lufs).toBeLessThan(-12);
    const ids = Object.values(musicLists).flatMap((l) => readList(l).response.items.map((i) => i.track.id));
    expect(ids).toContain(f.trackId);
  });

  test("hot: +3.0 dBTP in the excerpt itself, so the chain must attenuate by 4.5 dB", async () => {
    const { truePeak } = await measure(musicTracks.hot.file);
    expect(truePeak).toBeGreaterThanOrEqual(2.95);
    expect(gainFor(truePeak)).toBeCloseTo(-4.5, 1);
  });

  test("threshold: -1.6 dBTP, one tenth under the -1.5 target, so the gain is exactly 0", async () => {
    const { truePeak } = await measure(musicTracks.threshold.file);
    expect(truePeak).toBeCloseTo(-1.6, 1);
    expect(gainFor(truePeak)).toBe(0);
  });

  test("quiet: at most -5.2 dBTP, so the gain is never positive", async () => {
    const { truePeak } = await measure(musicTracks.quiet.file);
    expect(truePeak).toBeLessThanOrEqual(-5.2);
    expect(gainFor(truePeak)).toBe(0);
  });

  test("the 48 kHz variant is the only non-44.1 kHz fixture", () => {
    expect(Object.values(musicTracks).filter((f) => f.sampleRate === 48000).map((f) => f.trackId)).toEqual(["1644648520025224"]);
  });
});
