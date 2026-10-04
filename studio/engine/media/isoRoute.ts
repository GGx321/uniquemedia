import { probeVideo, soundAndPictureTracks, type ByteSource } from "./video/videoProbe";
import { formatOf } from "./sniff";

// Where a file of the MP4 or MOV family goes when the ONE drop zone took it (`kind: "any"`; 3f.6). The head of such a file cannot say whether it is a video or a
// track: an Android recorder writes a voice note as an `isom` or `mp42` file with a sound track and no picture, and the sniff has to call every file of those brands
// a video. So the TRACKS decide, read by the same bounded walker the video importer uses (`video/videoProbe.ts`: every box counted, bounded, the hidden handlers
// refused), never by ffmpeg and never by a file name:
//
//   a video track                                  -> the video importer, as before
//   no video track and at least one sound track    -> the audio importer
//   no video track and no sound track              -> refused: it is neither
//   a FRAGMENTED file                              -> a light pass over its tracks: sound and no picture -> the audio importer, else the video importer
//   a file the walker refuses for any other reason -> the video importer, which says why in its own words (`structure`, `codec`, `format`...)
//
// The decision is a HINT, not a verdict: the importer of the kind it names judges the staged copy again with its own tools (the music importer refuses any file with
// a picture stream in it), so a file that changes between this look and the copy gains nothing.

export type IsoRoute = "video" | "audio" | "neither";

/** Whether the bytes are of the MP4 or MOV family: the files whose head cannot tell a video from a track. */
export function isIsoFamily(head: Uint8Array): boolean {
  const format = formatOf(head);
  return format === "mp4" || format === "mov";
}

/** Where the walker's reading of `source` sends it. Rejects only when `source.read` does. */
export async function routeIsoFile(source: ByteSource): Promise<IsoRoute> {
  const probe = await probeVideo(source);
  if (probe.ok) return "video";
  if (probe.reason === "fragmented") {
    // Safari's MediaRecorder writes a voice note as a fragmented MP4, which the video walker refuses whole (3f.6 review, M1): a light pass over the tracks decides. A file with a
    // sound track and no picture is a track (the audio importer judges it again); anything else is the video importer's to refuse in its own words.
    const tracks = await soundAndPictureTracks(source);
    return tracks !== null && tracks.sound >= 1 && tracks.picture === 0 ? "audio" : "video";
  }
  if (probe.reason !== "no-video-track") return "video";
  return (probe.audioTracks ?? 0) >= 1 ? "audio" : "neither";
}
