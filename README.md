# uniquemedia — Instagram Video Uniquifier (engine + CLI)

Turns one source video into N verified-unique copies using randomized 2D and
pseudo-3D FFmpeg transforms, then verifies each copy with a PDQ-style perceptual
hash so it provably crosses a Hamming-distance threshold.

## Requirements
- bun

## Install
    bun install

## Usage
    bun run src/cli.ts <input.mp4> --count 30 --format reels --out out

Flags:
- `--count N` number of copies
- `--strength` visual-change multiplier (~0.5..1.5, default 1.0)
- `--format reels|feed|square`
- `--out DIR` output directory (default: out)
- `--target` minimum PDQ Hamming distance each copy must exceed (0..256, default 60)
- `--keep-audio` keep trend audio (no audio modification)
- `--mirror` allow horizontal flip
- `--seed` base seed for reproducible batches

## Test
    bun test

## Desktop app (Electron UI)

    bun install
    bun run dev      # launches the Electron app

Drop a video, set the number of copies, choose a format, press Uniquify, and watch
the queue fill with verified-unique copies (live progress + uniqueness badges).
Strength is auto-managed (the verification loop guarantees the threshold); a manual
strength slider lives under "Дополнительно". Build a distributable with `bun run build`.

## Notes
This transforms your own content; mass-posting may violate Instagram ToS — risk
is on the user. "Uniqueness" is measured, not guaranteed against a black box.
