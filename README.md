# uniquemedia — Instagram Video Uniquifier (engine + CLI)

Turns one source video into N verified-unique copies using randomized 2D and
pseudo-3D FFmpeg transforms, then verifies each copy with a PDQ-style perceptual
hash so it provably crosses a Hamming-distance threshold.

## Requirements
- bun

## Install
    bun install

## Usage
    bun run src/cli.ts <input.mp4> --count 30 --preset aggressive --format reels --out out --target 90

Flags:
- `--count N` number of copies
- `--preset light|medium|aggressive`
- `--format reels|feed|square`
- `--out DIR` output directory (default: out)
- `--target` minimum PDQ Hamming distance each copy must exceed (0..256)
- `--keep-audio` keep trend audio (no audio modification)
- `--mirror` allow horizontal flip
- `--seed` base seed for reproducible batches

## Test
    bun test

## Desktop app (Electron UI)

    bun install
    bun run dev      # launches the Electron app

Drop a video, set the number of copies, pick a preset and format, press Uniquify,
and watch the queue fill with verified-unique copies (live progress + uniqueness
badges). Build a distributable with `bun run build`.

## Notes
This transforms your own content; mass-posting may violate Instagram ToS — risk
is on the user. "Uniqueness" is measured, not guaranteed against a black box.
