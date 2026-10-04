import { fileURLToPath } from "node:url";

// The video fixtures of 3f.3a, pinned by size and sha256 (`fixtures.test.ts` checks both). `README.md` says what each is and how it was
// made; `generate.ts` makes them again (and prints the numbers below). Test-only: never imported by production code.

export interface VideoFixture {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

const fixture = (name: string, bytes: number, sha256: string): VideoFixture => ({ file: fileURLToPath(new URL(name, import.meta.url)), bytes, sha256 });

export const FIXTURES = {
  "hevc-hlg-chart.mp4": fixture("hevc-hlg-chart.mp4", 3632, "f5cfa263098cc7db899f08dd1e5249e39745efedc16e9ba881e126683ecdb52c"),
  "h264-sdr-chart.mp4": fixture("h264-sdr-chart.mp4", 3819, "37f8e0872d97c301ba8b337fd12281f0520758af5e83287ff91b936b94cfc7ba"),
  "h264-vfr.mp4": fixture("h264-vfr.mp4", 16963, "b223fb596770a03b0da1d2e0c2d6d80e4bb3006c63ab7782ce389046c27a9fbb"),
  "prores-hq-chart.mov": fixture("prores-hq-chart.mov", 2714, "6e79b610a0af0df6516cd28e611b5fdaeeb83396c66cdd63fbec716b6b3c0012"),
  "hevc-hlg-rotated-vfr.mov": fixture("hevc-hlg-rotated-vfr.mov", 3999, "79b9bd061fa4d881024852192a8740767db16b02f15b98ad05327928178bb87d"),
  "hevc-hlg-flat-4k.mp4": fixture("hevc-hlg-flat-4k.mp4", 5983, "cca26cc6ff4d78ce63b3d7a83a11f03abcac1de721f38fe5742e3812d78e7cdf"),
  "mpeg4-then-h264-two-video-tracks.mp4": fixture("mpeg4-then-h264-two-video-tracks.mp4", 3924, "9a281d28d592ef285bc019cf02bf4132732286b064cc2c9d1e04116c9a18653f"),
  "h264-sps-4224x2176-claims-1080p.mp4": fixture("h264-sps-4224x2176-claims-1080p.mp4", 28457, "26af94abd05c71677b38862f851e75159b84fd581cc1b007ad3e38873ea10f65"),
  "h264-copy-trim-ss0.5.mp4": fixture("h264-copy-trim-ss0.5.mp4", 50658, "9e51a2eaefbd0861c41c631a9f52f9b13a1b79ef9649d393bfbadb34d7e78f6a"),
  "h264-copy-trim-ss1.0.mp4": fixture("h264-copy-trim-ss1.0.mp4", 58133, "b5215319c121adf3762ad33ab6bef9328e7b176fd59f9f3c18615c157013efe8"),
  "h264-copy-trim-ss1.9.mp4": fixture("h264-copy-trim-ss1.9.mp4", 73052, "e88bb932303a25385602981ecb77e823b54ae3dc28725020d0cf6c46d5945985"),
  "h264-bframes.mp4": fixture("h264-bframes.mp4", 28895, "8d91d109a4c0f6b011a2589856a68626357e59ca0dc73e01f4274270236d76e1"),
  "hevc-bframes.mp4": fixture("hevc-bframes.mp4", 23165, "ff28482623bd67e33f3af5dd61deda41e806f53736e3dcb381e08b8f7a9887d3"),
  "h264-vfr-held-last-frame-bframes.mp4": fixture("h264-vfr-held-last-frame-bframes.mp4", 18868, "46016add2184bcf75c951784819bc2671de78746f97d54bcd12f191c09957b39"),
  "hevc-hlg-out-of-cube.mp4": fixture("hevc-hlg-out-of-cube.mp4", 5261, "b2c291ec0a428f8e075b974c5c9f994a37f1ee78f83e37dd2f830e8cc175b703"),
  "h264-p3-saturated.mp4": fixture("h264-p3-saturated.mp4", 1946, "face87d6c642967eea04353d3b4478a216867d0892a3079b4baea4cdd9bf9d9a"),
  "hevc-hlg-entry-terminator.mov": fixture("hevc-hlg-entry-terminator.mov", 3586, "e097840f931cbe322773844306c5c7d1e8f86170a4eb70c0a9b04274ce0d9f81"),
  "h264-entry-terminator.mov": fixture("h264-entry-terminator.mov", 1890, "6dba53396f2c0717cb59cb69a7f4bf24625224749b7d786dabd8eed214ad427e"),
  "h264-track-meta-mdta.mp4": fixture("h264-track-meta-mdta.mp4", 2054, "b73ede340b9c567a3761ff2c9300b36dee04d4c0e2a178c22beeac7f80cc54f8"),
} as const satisfies Record<string, VideoFixture>;

export type VideoFixtureName = keyof typeof FIXTURES;
