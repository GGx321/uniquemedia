# Music fixtures (Stage 3c.1)

Test inputs for the music tasks 3c.3 (flashapi client), 3c.4 (track store) and 3c.5 (audio
chain). They are pinned by size and sha256 in `index.ts` and verified by `fixtures.test.ts`.
Import the paths from `index.ts`; do not hard-code them.

## Licensing and ethics

The audio files are short excerpts (6 to 8 seconds, cut with `-c copy` from a full track) of
third-party commercial music, taken from the Instagram library through flashapi during the
SP0/SP5 spikes. They exist **only** as test fixtures in this private repository. They are
never shipped in the app, never played to users and never redistributed. Do not copy them out
of the repo, and do not lengthen them: each is only as long as the 3c.5 tests need. The
list JSON carries public track metadata (titles, artists, cover URLs) for the same purpose.

## Lists (`lists/`)

Two responses of the flashapi trending endpoint, byte-for-byte as captured, except that
`response.alacorn_session_id` is replaced with `"REDACTED"`. Neither response carries the
RapidAPI key (the key travels in a request header, which was never stored); the test greps
for it anyway.

**The signed CDN URLs (`oh=`, `oe=`) are left in.** They expired about 104 to 108 hours
after the capture (2026-09-27), so they grant nothing. The `_nc_gid` parameter in them is a CDN session id of flashapi's requester, not the owner's,
and it expired with the URLs. The `oe=` values are still useful as
real-world input for the expiry parser.

| File | Edge | Items | Notable |
| --- | --- | --- | --- |
| `list-2026-09-27T2042Z-kyiv.json` | `instagram.fkiv8-1.fna.fbcdn.net` | 30 | 4 items without `ig_username`/`artist_id`, 8 explicit, 17 with unsorted highlights |
| `list-2026-09-27T2151Z-frankfurt.json` | `scontent-fra3-{1,2}.cdninstagram.com` (downloads; `fra5` appears only in previews and covers) | 30 | 3 items without `ig_username`/`artist_id`, 10 explicit, 19 with unsorted highlights |

Together the lists hold the 7 items lacking `ig_username`/`artist_id`, the explicit ones,
the two CDN host patterns, `1500` as a highlight, and no `is_trending_in_clips`.

## Tracks (`tracks/`)

HE-AAC (`mp4a.40.5`) stereo in MP4, as the API delivers it (`-c copy`; the source tags are dropped, only the container brands and `encoder=Lavf60.3.100` from the cut remain). The
true peaks and loudness were measured on the excerpts themselves with ffmpeg
`ebur128=peak=true`, because invariant 21 measures the clip segment, not the whole track.

| File | Track | Cut | True peak | Purpose |
| --- | --- | --- | --- | --- |
| `hot-4199287736976977.mp4` | 4199287736976977 | 82 s, 8 s long | +3.0 dBTP | invariant 21 hot: needs -4.5 dB |
| `threshold-774126508789756.mp4` | 774126508789756 | 72 s, 8 s long | -1.6 dBTP | invariant 21 threshold: right at the -1.5 target, gain 0 |
| `quiet-4207179866261956.mp4` | 4207179866261956 | 8 s, 8 s long | -5.7 dBTP | invariant 21 quiet: at most -5.2, gain 0 |
| `he-aac-48k-1644648520025224.mp4` | 1644648520025224 | 24 s, 6 s long | -5.5 dBTP | the 48 kHz input variant (the rest are 44.1 kHz) |

Not here: the audio file that carries title and artist tags (invariant 14). The API tracks
have no tags, so 3c.5 makes that file itself, at test time, from the hot excerpt (`../testing/taggedTrack.ts`).
