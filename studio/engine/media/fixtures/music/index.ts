import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MediaFormat } from "../../sniff";

// The own-music importer's fixtures (Stage 3, 3f.4): a few KB each, made by `generate.ts` from sine tones with the bundled ffmpeg (no
// third-party audio). Size and sha256 are pinned here and checked by `fixtures.test.ts`. Test-only: never imported by production code.

const here = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));

export interface MusicFixture {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** What the sniff names the container. */
  readonly format: MediaFormat;
  /** The codec ffmpeg names. */
  readonly codec: string;
  readonly sampleRate: number;
  readonly channels: number;
  /** The tone's length as it was made, in ms; a decode is within about 70 ms of it (frames, priming and padding). */
  readonly durationMs: number;
}

const fixture = (name: string, rest: Omit<MusicFixture, "file">): MusicFixture => ({ file: here(name), ...rest });

/** One source per accepted format, each a stereo or mono tone. */
export const musicFixtures = {
  mp3: fixture("tone.mp3", { bytes: 3989, sha256: "c5b5f13e6d4abb3f09594694a40fdee0d0d3507f071f22db8ae0741cbc881169", format: "mp3", codec: "mp3", sampleRate: 44100, channels: 2, durationMs: 600 }),
  m4a: fixture("tone.m4a", { bytes: 4399, sha256: "487b15b1839ab4333f8e7eb1cf544deae36f226abf4e43ccb8b222438c651420", format: "m4a", codec: "aac", sampleRate: 44100, channels: 2, durationMs: 600 }),
  aac: fixture("tone.aac", { bytes: 3710, sha256: "77807269fef71a8fecd7a312f172fccee5f9dcbea8ac4e1820e7c07d59c8eed6", format: "aac", codec: "aac", sampleRate: 44100, channels: 2, durationMs: 600 }),
  wav: fixture("tone.wav", { bytes: 9644, sha256: "eff9ec49a65712ce1706a82f4757c243533400ed5167321da47805a2700381bd", format: "wav", codec: "pcm_s16le", sampleRate: 8000, channels: 1, durationMs: 600 }),
  flac: fixture("tone.flac", { bytes: 9477, sha256: "72adb39e5e1914b7498dde51e3fa21cdd6913a7a8b3ebdb8c2e0e4da3f74a490", format: "flac", codec: "flac", sampleRate: 8000, channels: 1, durationMs: 300 }),
  alac: fixture("tone.alac.m4a", { bytes: 4738, sha256: "579d6abbfb07a4a168530ca61d3f0b7d99295d0b5ebe7943dacb20f6fd81a1ad", format: "m4a", codec: "alac", sampleRate: 22050, channels: 2, durationMs: 400 }),
  ogg: fixture("tone.ogg", { bytes: 5434, sha256: "85bb87e7e609efdc0494e7afdab77282796a4e363c1b4d36b7639024c350d223", format: "ogg", codec: "vorbis", sampleRate: 44100, channels: 2, durationMs: 600 }),
  opus: fixture("tone.opus", { bytes: 2882, sha256: "dd3ebec2dce62b353431916636be134826d06565862c211c907f7721b2fe79e1", format: "ogg", codec: "opus", sampleRate: 48000, channels: 2, durationMs: 600 }),
  /** An audio-only MP4 of brand `isom`: the sniff calls it `mp4` (a video or a track), the importer settles it from the streams. */
  isomMp4: fixture("tone.isom.mp4", { bytes: 4419, sha256: "406557edf93617fc423ecf918ea1b651f55de2e2f7d75e35cc4661a8558fd99c", format: "mp4", codec: "aac", sampleRate: 44100, channels: 2, durationMs: 600 }),
  /** Six channels at 8 kHz. */
  surround: fixture("surround.flac", { bytes: 12037, sha256: "2d6f6c7f6937e26c2a5ebd23ae043ec200488c543f3122ddf8104c2cd00e3b12", format: "flac", codec: "flac", sampleRate: 8000, channels: 6, durationMs: 150 }),
  wav24: fixture("tone24.wav", { bytes: 7268, sha256: "159a5ce8c27f1a76304656307a909a24f199917e312e37e33ddc92b37cc4770d", format: "wav", codec: "pcm_s24le", sampleRate: 8000, channels: 1, durationMs: 300 }),
  /** An mp3 with the title `SecretTitle-XYZ-1234`, the artist `SecretArtist-XYZ-5678` and a 16x16 front cover (an `APIC` frame). */
  taggedMp3: fixture("tagged-cover.mp3", { bytes: 4296, sha256: "5212b47275b7fbe2b0ef6d122ae46c9a2d89791627fe66794e961aca53b8c5bc", format: "mp3", codec: "mp3", sampleRate: 44100, channels: 2, durationMs: 600 }),
  /** The same tags and cover as an m4a (`ilst` and `covr`). */
  taggedM4a: fixture("tagged-cover.m4a", { bytes: 4719, sha256: "64c67ac6b96289eb2de5d89a2854bbb1a2fa52e599b8f3ee1b3c8bc905e54e13", format: "m4a", codec: "aac", sampleRate: 44100, channels: 2, durationMs: 600 }),
  /** An M4A whose second stream is a REAL video (not an attached picture): not music. */
  m4aWithVideo: fixture("m4a-with-video.m4a", { bytes: 4297, sha256: "d4a270880c7f6e144a821b3192a6d8f5fe245c93168fd25bb9fabe2792276d68", format: "m4a", codec: "aac", sampleRate: 44100, channels: 2, durationMs: 400 }),
  /** A WAV in a codec the importer does not take (MS ADPCM). */
  adpcmWav: fixture("adpcm.wav", { bytes: 2138, sha256: "e086efc8f4d4356a725250e229127a72675f1004e283ffab30fb53615c41a5c7", format: "wav", codec: "adpcm_ms", sampleRate: 8000, channels: 1, durationMs: 300 }),
} as const satisfies Record<string, MusicFixture>;

export type MusicFixtureName = keyof typeof musicFixtures;

/** The bytes of a fixture. */
export function fixtureBytes(name: MusicFixtureName): Uint8Array {
  return new Uint8Array(readFileSync(musicFixtures[name].file));
}

/** The text the tagged fixtures carry, which no import may keep. */
export const FIXTURE_TAGS = { title: "SecretTitle-XYZ-1234", artist: "SecretArtist-XYZ-5678" } as const;
