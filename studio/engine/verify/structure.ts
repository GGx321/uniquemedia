import { FPS, FRAME_H, FRAME_W } from "../../shared/montage";
import type { Findings, Mp4Box } from "./boxes";
import { kids, readHandler } from "./checks";
import { latin1, u16, u32, u64, u8 } from "./reader";

// The structure checks (invariant 20, A4): which tracks the file has, their
// codec, size, rate and colour tags, the exact video frame count, and how the
// durations relate. Every check reads the moov buffer and reports by code.

/**
 * How far the movie and the audio track may be from the video track, in ms.
 *
 * The video is exactly `frames / 30` s: the graph builds it that way and the
 * frame count is checked exactly. The audio cannot be exact: AAC works in
 * 1024-sample frames (21.333 ms at 48 kHz), so the encoder pads up to the next
 * frame and writes a priming delay (the spike found ~22 ms, one frame, over
 * the sum after a stream-copied concat, and 3a.5 measured the single-encode
 * audio between 0.5 ms over and 21.3 ms under the video). So the audio track
 * and the movie (the longer of the tracks) may each be up to TWO AAC frames,
 * 42.67 ms, from the video: one for the padding and one for the priming edit.
 * The movie timescale is 1 ms, so the bound is stated as 43. The duration is
 * never asserted exactly (spike README); the frame count is the exact check.
 */
export const AV_TOLERANCE_MS = 43;

/**
 * How far the video track may be from `frames / 30` s, in ms. The track header
 * counts in the movie timescale (1 ms), so rounding alone can be off by 1;
 * 2 leaves one millisecond for a build that rounds the other way. A frame is
 * 33.3 ms, so this still catches a wrong frame rate or a lost frame.
 */
export const VIDEO_TOLERANCE_MS = 2;

const AVC_ENTRY = "avc1";
const AAC_ENTRY = "mp4a";
/** colr nclx: BT.709 primaries, transfer and matrix are all code 1. */
const BT709 = 1;
/** AAC-LC's audio object type, 48 kHz's sampling frequency index, and stereo's channel configuration. */
const AAC_LC = 2;
const FREQUENCY_INDEX_48K = 3;
const CHANNELS_STEREO = 2;
/** MPEG-4 audio in an `esds` decoder config. */
const OBJECT_TYPE_MPEG4_AUDIO = 0x40;

interface Track {
  readonly trak: Mp4Box;
  readonly kind: string;
  readonly tkhd: Mp4Box | undefined;
  readonly stsd: Mp4Box | undefined;
  readonly stsz: Mp4Box | undefined;
}

function describeTrack(bytes: Uint8Array, trak: Mp4Box, findings: Findings): Track {
  const mdia = kids(trak, "mdia")[0];
  const hdlr = mdia && kids(mdia, "hdlr")[0];
  const handler = hdlr && readHandler(bytes, hdlr, findings);
  const stbl = mdia && kids(kids(mdia, "minf")[0] ?? mdia, "stbl")[0];
  return { trak, kind: handler ? handler.type : "????", tkhd: kids(trak, "tkhd")[0], stsd: stbl && kids(stbl, "stsd")[0], stsz: stbl && kids(stbl, "stsz")[0] };
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** `mvhd`: version and flags, creation, modification, timescale, duration (32-bit in version 0, 64-bit in 1). */
function movieTiming(bytes: Uint8Array, mvhd: Mp4Box): { timescale: number; duration: number } | undefined {
  const version = u8(bytes, mvhd.body);
  if (version !== 0 && version !== 1) return undefined;
  const timescale = u32(bytes, mvhd.body + (version === 1 ? 20 : 12));
  const duration = version === 1 ? u64(bytes, mvhd.body + 24) : u32(bytes, mvhd.body + 16);
  return timescale === undefined || duration === undefined ? undefined : { timescale, duration };
}

/** `tkhd`: version and flags, creation, modification, track id, reserved, duration (in the movie timescale). */
function trackDuration(bytes: Uint8Array, tkhd: Mp4Box): number | undefined {
  const version = u8(bytes, tkhd.body);
  if (version === 1) return u64(bytes, tkhd.body + 28);
  return version === 0 ? u32(bytes, tkhd.body + 20) : undefined;
}

function checkDurations(bytes: Uint8Array, mvhd: Mp4Box | undefined, video: Track | undefined, audio: Track | undefined, frames: number, findings: Findings): void {
  if (!mvhd) return void findings.add("MISSING_BOX", "moov has no mvhd box", "moov/mvhd");
  const timing = movieTiming(bytes, mvhd);
  if (!timing || timing.timescale === 0) return void findings.add("DURATION_MISMATCH", "the movie timescale is missing or 0, so no duration can be read", mvhd.path);
  const ms = (units: number | undefined): number | undefined => (units === undefined ? undefined : (units * 1000) / timing.timescale);
  const movieMs = ms(timing.duration);
  const videoMs = video?.tkhd && ms(trackDuration(bytes, video.tkhd));
  const audioMs = audio?.tkhd && ms(trackDuration(bytes, audio.tkhd));
  const expectedMs = (frames * 1000) / FPS;
  const show = (v: number): string => v.toFixed(1);

  if (video && videoMs === undefined) findings.add("DURATION_MISMATCH", "the video track header holds no readable duration", video.trak.path);
  if (videoMs === undefined) return;
  if (Math.abs(videoMs - expectedMs) > VIDEO_TOLERANCE_MS) {
    findings.add("DURATION_MISMATCH", `the video track is ${show(videoMs)} ms, ${frames} frames at ${FPS} fps is ${show(expectedMs)} ms (tolerance ${VIDEO_TOLERANCE_MS} ms)`, video?.trak.path);
  }
  if (movieMs === undefined || Math.abs(movieMs - videoMs) > AV_TOLERANCE_MS) {
    findings.add("DURATION_MISMATCH", `the movie is ${movieMs === undefined ? "unreadable" : `${show(movieMs)} ms`}, the video track ${show(videoMs)} ms (tolerance ${AV_TOLERANCE_MS} ms)`, mvhd.path);
  }
  if (audio && (audioMs === undefined || Math.abs(audioMs - videoMs) > AV_TOLERANCE_MS)) {
    findings.add("DURATION_MISMATCH", `the audio track is ${audioMs === undefined ? "unreadable" : `${show(audioMs)} ms`}, the video track ${show(videoMs)} ms (tolerance ${AV_TOLERANCE_MS} ms)`, audio.trak.path);
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

function checkVideo(bytes: Uint8Array, track: Track, frames: number, findings: Findings): void {
  const wrong = (message: string, path = track.trak.path): void => findings.add("VIDEO_FORMAT_WRONG", message, path);
  if (track.tkhd) {
    // The last two fields of `tkhd` are the width and height, 16.16 fixed point.
    const w = u32(bytes, track.tkhd.end - 8);
    const h = u32(bytes, track.tkhd.end - 4);
    if (w === undefined || h === undefined || w >>> 16 !== FRAME_W || h >>> 16 !== FRAME_H) {
      wrong(`the track header says ${w === undefined ? "?" : w >>> 16}x${h === undefined ? "?" : h >>> 16}, expected ${FRAME_W}x${FRAME_H}`, track.tkhd.path);
    }
  }
  const entry = track.stsd?.children[0];
  if (!track.stsd || !entry) return wrong("the video track has no sample entry");
  if (u32(bytes, track.stsd.body + 4) !== 1 || track.stsd.children.length !== 1) wrong("the video track does not have exactly one sample entry", track.stsd.path);
  if (entry.type !== AVC_ENTRY) return wrong(`the video sample entry is '${entry.type}', expected '${AVC_ENTRY}' (H.264)`, entry.path);
  const w = u16(bytes, entry.start + 32);
  const h = u16(bytes, entry.start + 34);
  if (w !== FRAME_W || h !== FRAME_H) wrong(`the video sample entry is ${w}x${h}, expected ${FRAME_W}x${FRAME_H}`, entry.path);
  const children = entry.children;
  if (!children.some((c) => c.type === "avcC")) wrong("the video sample entry has no avcC configuration", entry.path);
  for (const colr of children.filter((c) => c.type === "colr")) checkColour(bytes, colr, findings);

  const count = track.stsz ? u32(bytes, track.stsz.body + 8) : undefined;
  if (count === undefined) return wrong("the video track has no readable stsz sample count");
  if (count !== frames) findings.add("FRAME_COUNT_MISMATCH", `the video has ${count} frames, expected exactly ${frames}`, track.stsz?.path);
}

/** `colr`: the colour type, and for `nclx` primaries, transfer, matrix (16 bits each) and a flags byte whose top bit is full range. Tagged BT.709 limited range or not at all. */
function checkColour(bytes: Uint8Array, colr: Mp4Box, findings: Findings): void {
  const type = latin1(bytes, colr.body, colr.body + 4);
  const primaries = u16(bytes, colr.body + 4);
  const transfer = u16(bytes, colr.body + 6);
  const matrix = u16(bytes, colr.body + 8);
  const flags = u8(bytes, colr.body + 10);
  const ok = type === "nclx" && primaries === BT709 && transfer === BT709 && matrix === BT709 && flags !== undefined && (flags & 0x80) === 0;
  if (!ok) findings.add("COLOUR_TAG_WRONG", `colr is ${type} ${primaries}/${transfer}/${matrix} flags ${flags}, expected nclx 1/1/1 with full_range 0 (BT.709 limited)`, colr.path);
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

interface Descriptor {
  readonly tag: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

/** An MPEG-4 descriptor: a tag byte, then a length in 1 to 4 bytes of 7 bits each (top bit: more follow). */
function readDescriptor(bytes: Uint8Array, at: number, end: number): Descriptor | undefined {
  const tag = u8(bytes, at);
  if (tag === undefined) return undefined;
  let length = 0;
  let cursor = at + 1;
  for (let i = 0; i < 4; i++) {
    const b = u8(bytes, cursor++);
    if (b === undefined) return undefined;
    length = length * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      const bodyEnd = cursor + length;
      return bodyEnd <= end ? { tag, bodyStart: cursor, bodyEnd } : undefined;
    }
  }
  return undefined;
}

interface AudioConfig {
  readonly objectType: number;
  readonly audioObjectType: number;
  readonly frequencyIndex: number;
  readonly channels: number;
}

/** `esds`: version and flags, then ES_Descriptor (0x03) > DecoderConfigDescriptor (0x04) > DecoderSpecificInfo (0x05), whose first bits are the AudioSpecificConfig. */
function readAudioConfig(bytes: Uint8Array, esds: Mp4Box): AudioConfig | undefined {
  const es = readDescriptor(bytes, esds.body + 4, esds.end);
  if (es?.tag !== 0x03) return undefined;
  let at = es.bodyStart + 2; // ES_ID
  const flags = u8(bytes, at++);
  if (flags === undefined) return undefined;
  if (flags & 0x80) at += 2; // dependsOn_ES_ID
  if (flags & 0x40) at += 1 + (u8(bytes, at) ?? 0); // URL
  if (flags & 0x20) at += 2; // OCR_ES_ID
  const config = readDescriptor(bytes, at, es.bodyEnd);
  if (config?.tag !== 0x04) return undefined;
  const objectType = u8(bytes, config.bodyStart);
  // objectTypeIndication, streamType, bufferSizeDB (3), maxBitrate (4), avgBitrate (4): 13 bytes.
  const specific = readDescriptor(bytes, config.bodyStart + 13, config.bodyEnd);
  const b0 = specific?.tag === 0x05 ? u8(bytes, specific.bodyStart) : undefined;
  const b1 = specific?.tag === 0x05 ? u8(bytes, specific.bodyStart + 1) : undefined;
  if (objectType === undefined || b0 === undefined || b1 === undefined) return undefined;
  return { objectType, audioObjectType: b0 >> 3, frequencyIndex: ((b0 & 7) << 1) | (b1 >> 7), channels: (b1 >> 3) & 0xf };
}

function checkAudio(bytes: Uint8Array, track: Track, findings: Findings): void {
  const wrong = (message: string, path = track.trak.path): void => findings.add("AUDIO_FORMAT_WRONG", message, path);
  const entry = track.stsd?.children[0];
  if (!track.stsd || !entry) return wrong("the audio track has no sample entry");
  if (u32(bytes, track.stsd.body + 4) !== 1 || track.stsd.children.length !== 1) wrong("the audio track does not have exactly one sample entry", track.stsd.path);
  if (entry.type !== AAC_ENTRY) return wrong(`the audio sample entry is '${entry.type}', expected '${AAC_ENTRY}' (AAC)`, entry.path);
  if (u16(bytes, entry.start + 16) !== 0) return wrong("the audio sample entry is not version 0", entry.path);
  const channels = u16(bytes, entry.start + 24);
  const rate = u16(bytes, entry.start + 32);
  const rateFraction = u16(bytes, entry.start + 34);
  if (channels !== CHANNELS_STEREO) wrong(`the audio sample entry has ${channels} channels, expected ${CHANNELS_STEREO}`, entry.path);
  if (rate !== 48000 || rateFraction !== 0) wrong(`the audio sample entry rate is ${rate}.${rateFraction}, expected 48000`, entry.path);
  const esds = entry.children.find((c) => c.type === "esds");
  const config = esds && readAudioConfig(bytes, esds);
  if (!esds || !config) return wrong("the audio sample entry has no readable esds AudioSpecificConfig", entry.path);
  if (config.objectType !== OBJECT_TYPE_MPEG4_AUDIO) wrong(`the audio object type indication is 0x${config.objectType.toString(16)}, expected 0x40 (MPEG-4 audio)`, esds.path);
  if (config.audioObjectType !== AAC_LC) wrong(`the audio object type is ${config.audioObjectType}, expected ${AAC_LC} (AAC-LC)`, esds.path);
  if (config.frequencyIndex !== FREQUENCY_INDEX_48K) wrong(`the AudioSpecificConfig sampling frequency index is ${config.frequencyIndex}, expected ${FREQUENCY_INDEX_48K} (48 kHz)`, esds.path);
  if (config.channels !== CHANNELS_STEREO) wrong(`the AudioSpecificConfig has channel configuration ${config.channels}, expected ${CHANNELS_STEREO}`, esds.path);
}

// ---------------------------------------------------------------------------
// The whole
// ---------------------------------------------------------------------------

/** Runs every structure check over the children of `moov` (offsets are into `bytes`, the moov buffer). */
export function checkStructure(bytes: Uint8Array, moovChildren: readonly Mp4Box[], frames: number, findings: Findings): void {
  const tracks = moovChildren.filter((c) => c.type === "trak").map((trak) => describeTrack(bytes, trak, findings));
  const videos = tracks.filter((t) => t.kind === "vide");
  const audios = tracks.filter((t) => t.kind === "soun");
  if (tracks.length !== videos.length + audios.length || videos.length > 1 || audios.length > 1) {
    findings.add("UNEXPECTED_TRACKS", `the file has ${tracks.length} tracks (${videos.length} video, ${audios.length} audio, ${tracks.length - videos.length - audios.length} other), expected one video and one audio`, "moov/trak");
  }
  const video = videos[0];
  const audio = audios[0];
  if (!video) findings.add("MISSING_TRACK", "the file has no video track", "moov/trak");
  if (!audio) findings.add("MISSING_TRACK", "the file has no audio track", "moov/trak");
  if (video) checkVideo(bytes, video, frames, findings);
  if (audio) checkAudio(bytes, audio, findings);
  checkDurations(bytes, moovChildren.find((c) => c.type === "mvhd"), video, audio, frames, findings);
}
