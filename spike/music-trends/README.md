# Music trends spike

A throwaway local tool to check one thing: pull currently-trending music —
from TikTok or from Instagram's own trending list — and bake a chosen track
into a test 1080x1920 Reel, so it can be uploaded to Instagram (a draft is
enough) to see whether Instagram recognises and credits the track.

## Run

```
bun spike/music-trends/server.ts
```

It binds to `127.0.0.1` starting at port `5178` (and walks forward to the next
free port if that one is taken) and prints the URL it's listening on. Open
that URL in a browser.

The TikTok source needs no API key or `.env`. The Instagram source needs
Alex's RapidAPI "flashapi" key, exported in the shell (never read from a
`.env` file):

```
RAPIDAPI_KEY=... bun --no-env-file spike/music-trends/server.ts
```

`--no-env-file` stops Bun from auto-loading the repo's `.env` (which holds
other, unrelated secrets) into this process — only the `RAPIDAPI_KEY` you
export on the command line is read. Without it, the Instagram tab still
works for browsing any previously cached response; it just can't refresh.

## What it does

- **Trending feed** — calls tikwm's free, unofficial `feed/list` endpoint
  (`POST https://www.tikwm.com/api/feed/list`) a configurable number of times,
  rate-limited to roughly one call per 1.1s with a couple of retries on
  failure, and aggregates the returned videos by their `music_info.id`. Each
  unique sound is counted (how many trending videos used it) and tagged as a
  "song" or an "original sound" clip.
- **Audio preview** — clicking a track in the list plays its audio, proxied
  and cached once per sound under the OS temp dir (never inside the repo), so
  the `<audio>` element can seek via HTTP Range requests.
- **Render** — picks a start point and length (5–60s, default 15, clamped to
  the audio's own length) from the chosen track, and bakes it into a
  1080x1920 H.264/AAC mp4 with a 0.5s fade-in and 1s fade-out, over either:
  - a generated animated placeholder background (with a "тест музыки" text
    overlay when a Cyrillic-capable font is found on the machine — silently
    skipped otherwise),
  - an uploaded photo (Ken Burns zoom), or
  - an uploaded video (cropped/scaled to 9:16, original audio replaced).

  Rendering shells out to the ffmpeg binary already vendored via the
  `ffmpeg-static` dependency (via `Bun.spawn`, no shell, with a timeout), and
  probes the audio's real duration with `ffprobe-static`. Works the same way
  for the Instagram source, whose tracks are AAC audio in an mp4 container
  rather than tikwm's mp3 — ffmpeg reads either as a plain audio input.
- **Instagram trending (flashapi)** — a second source, switched to with the
  radio buttons at the top. Calls Alex's RapidAPI "flashapi" subscription
  (`GET https://flashapi1.p.rapidapi.com/ig/music_trending/`), which has a
  30-request/month quota, so **the cache is the core feature**, not an
  optimization:
  - Every successful response is saved as timestamped JSON under
    `os.tmpdir()/music-trends-cache/flashapi/`.
  - The page always shows the latest cached response by default — opening the
    Instagram tab, or reloading, never spends a request.
  - Only the explicit "Обновить (тратит 1 запрос из 30)" button calls the
    real API. It is never retried automatically on failure.
  - RapidAPI's quota headers (`x-ratelimit-requests-remaining` /
    `-limit`), when present, are shown next to the refresh button.
  - Each track's `progressive_download_url` (a signed CDN url that expires in
    a few days) is downloaded into the cache the first time it's played or
    rendered, so the expiring url is only ever needed once.
  - Instagram's own "best part" markers (`highlight_start_times_in_ms`) show
    up as small buttons next to the start slider; selecting a track defaults
    the render start to the first one.
  - A "только в тренде" filter (off by default) narrows the list to tracks
    with `metadata.is_trending_in_clips`.
  - The base URL is overridable via `FLASHAPI_BASE_URL`, for pointing the
    server at a local test stub instead of the real host — used only by the
    spike's own verification, never in normal use.

## Known limits

- **Unofficial source.** tikwm is a free, undocumented third-party API. It can
  change shape or disappear without notice; the GET endpoint has been
  observed to fail while POST works, and individual calls sometimes return
  `code !== 0` under light rate limiting even a bit over 1s apart — the
  fetcher retries a couple of times before giving up on a page and moving on,
  and the trending endpoint reports which pages failed.
- **TikTok trends ≠ Instagram trends.** What's trending in TikTok's own feed
  is not the same signal Instagram Reels uses; this tool only tells you what
  *TikTok* currently surfaces, as a rough proxy.
- **Instagram's own library.** Instagram will only recognise and credit a
  track that already exists in *its* music library — baking a TikTok-sourced
  MP3 into a video's audio track does not itself add it to that library. This
  is exactly the open question the tool is built to probe by hand.
- **Best-effort text overlay.** The "тест музыки" caption on the generated
  background depends on finding a Cyrillic-capable font file on the running
  machine at startup; if none is found (or the `drawtext` filter isn't usable
  in the local ffmpeg build), the render silently proceeds without text
  rather than failing.
- **Unverified pagination param.** flashapi's sample response shows
  `page_info.next_max_id` but not what the *request* param for the next page
  is actually called; the server sends it as `max_id` (one constant,
  `FLASHAPI_MAX_ID_PARAM`, in `server.ts`) as a best guess pending a real
  paginated call.
