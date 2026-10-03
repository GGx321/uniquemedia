/**
 * The peak-RSS reader of `/usr/bin/time` (shared with `studio/scripts/layers/measureLayerRss.ts`). 3b.5 measured here, with pass 2 taking the
 * stickers as direct overlays, that the dominant cost is a constant per overlay input (ten default stickers: 816 MiB against the 768 MiB
 * budget). 3b.6 answered that with the layer pass, and pass 2 no longer takes a layer directly, so that measurement is gone with its path:
 * `measureLayerRss.ts` measures the layer pass instead.
 */

/** The peak RSS in bytes from `/usr/bin/time -l` (macOS, bytes) or `-v` (GNU, kilobytes) output, if it is there. */
export function parseMaxRssBytes(stderr: string): number | undefined {
  const mac = /^\s*(\d+)\s+maximum resident set size\s*$/m.exec(stderr);
  if (mac?.[1] !== undefined) return Number(mac[1]);
  const gnu = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  if (gnu?.[1] !== undefined) return Number(gnu[1]) * 1024;
  return undefined;
}
