import { fileURLToPath } from "node:url";

// The music fixtures (Stage 3c.1). The lists are captured API responses; the tracks are SYNTHETIC (generate.ts: tones, noise and bursts, encoded to HE-AAC), because the
// repository is public and no commercial recording may be committed. Later
// tests (3c.3 client, 3c.4 store, 3c.5 audio chain) import their paths from
// here rather than hard-coding them. Size and sha256 are pinned by
// fixtures.test.ts; README.md says how the files are made and why they are
// short. Test-only: never imported by production code.

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** The two download-host patterns of invariant 31 (label-boundary, lowercase); 3c.4 imports these. */
export const cdnHostPatterns: readonly RegExp[] = [/^scontent-[a-z0-9]+-[0-9]+\.cdninstagram\.com$/, /^instagram\.[a-z0-9]+-[0-9]+\.fna\.fbcdn\.net$/];

export interface MusicListFixture {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** `fetchedAt` in the file; the signed URLs inside expire 104 to 108 h after it. */
  readonly fetchedAt: string;
  /** Every `progressive_download_url` in the list is on one of these hosts. */
  readonly downloadHosts: readonly string[];
  readonly itemCount: number;
  /** Track ids lacking both `ig_username` and `artist_id`. */
  readonly withoutIgUsername: readonly string[];
  readonly explicitCount: number;
  readonly purpose: string;
}

export interface MusicTrackFixture {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** The id of the list track this file stands in for: the fake CDN serves these bytes under that track's download URL. */
  readonly trackId: string;
  /** Length, to the nearest 10 ms (AAC frames make it inexact). */
  readonly durationMs: number;
  readonly sampleRate: 44100 | 48000;
  /** Measured on the file with ffmpeg `ebur128=peak=true`, to 0.1 dB; generate.ts searches for the signal level that lands on it. */
  readonly truePeakDbtp: number;
  readonly purpose: string;
}

export const musicLists = {
  kyiv: {
    file: here("./lists/list-2026-09-27T2042Z-kyiv.json"),
    bytes: 196582,
    sha256: "4c33d97bed5917a3a2c15fdccd5f7ee01236c55256b0c9412bcf86b9f40f15e9",
    fetchedAt: "2026-09-27T20:42:44.190Z",
    downloadHosts: ["instagram.fkiv8-1.fna.fbcdn.net"],
    itemCount: 30,
    withoutIgUsername: ["1395615172492847", "838938922289733", "747164902875118", "2160616664666764"],
    explicitCount: 8,
    purpose: "Client and store input: the fbcdn.net host pattern, 4 items without ig_username/artist_id, explicit tracks, unsorted highlights.",
  },
  frankfurt: {
    file: here("./lists/list-2026-09-27T2151Z-frankfurt.json"),
    bytes: 187543,
    sha256: "00d8ab6dd6c9793ad16f0866b3fadc4fa2a71873e4757c1f9fbf48598cd25fdd",
    fetchedAt: "2026-09-27T21:51:56.823Z",
    downloadHosts: ["scontent-fra3-1.cdninstagram.com", "scontent-fra3-2.cdninstagram.com"],
    itemCount: 30,
    withoutIgUsername: ["856647240351078", "1395615172492847", "747743264793098"],
    explicitCount: 10,
    purpose: "Client and store input: the cdninstagram.com host pattern, 3 items without ig_username/artist_id, explicit tracks, unsorted highlights.",
  },
} as const satisfies Record<string, MusicListFixture>;

export const musicTracks = {
  hot: {
    file: here("./tracks/hot.mp4"),
    bytes: 48360,
    sha256: "9fc6cf100f3d65118af6266d9be54f5000648f98b3d5cf416eac2190cde9bd08",
    trackId: "4199287736976977",
    durationMs: 8030,
    sampleRate: 44100,
    truePeakDbtp: 3.0,
    purpose: "Invariant 21 hot: +3.0 dBTP, needs -4.5 dB.",
  },
  threshold: {
    file: here("./tracks/threshold.mp4"),
    bytes: 42060,
    sha256: "db3e548f3bb2e2b9240d0bde346337b68353245218d424ea517e6572d7248c9a",
    trackId: "774126508789756",
    durationMs: 8040,
    sampleRate: 44100,
    truePeakDbtp: -1.6,
    purpose: "Invariant 21 threshold: right at the -1.5 dB target, gain 0.",
  },
  quiet: {
    file: here("./tracks/quiet.mp4"),
    bytes: 38350,
    sha256: "34e360acd9f6897178d4594603443b3cd5d84aa2c712bb5646fe67b1ffc9de00",
    trackId: "4207179866261956",
    durationMs: 8030,
    sampleRate: 44100,
    truePeakDbtp: -5.7,
    purpose: "Invariant 21 quiet: at most -5.2 dBTP, gain 0.",
  },
  he48k: {
    file: here("./tracks/he-aac-48k.mp4"),
    bytes: 34848,
    sha256: "f4a15f5c49148a39bcc085d3d3e1548809e5df4bbbad868d1e6b8e217386342e",
    trackId: "1644648520025224",
    durationMs: 6020,
    sampleRate: 48000,
    truePeakDbtp: -5.5,
    purpose: "The 48 kHz HE-AAC input variant (the API serves a few; the rest are 44.1 kHz).",
  },
} as const satisfies Record<string, MusicTrackFixture>;
