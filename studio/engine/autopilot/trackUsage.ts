import { z } from "zod";
import { AUTOPILOT_RECENT_VIDEOS, trackKey, type TrackUsage } from "../../shared/autopilot/track";
import { Id } from "../../shared/engine";
import { readVideoRecordFiles } from "../videos/listing";

// `trackUsage(avatarId)` (Stage 4 plan §7, S4.4): how often each track was used for an avatar, from its video records. The record keeps the
// RESOLVED spec, and `spec.music` names the track: `trackId` for a trending one, `mediaId` for an own one. Every video counts, a manual one as
// well as an autopilot one: the point is to vary what the avatar's audience hears, whoever made the video.
//
// A video without a readable `music` (a silent one, or a record from before music was kept in the spec) uses no track but still takes one of
// the last videos' slots in `recent`. A record that cannot be read at all leaves the usage `complete: false`, because its track is unknown;
// the chooser ranks by what is known and never waits because of it.

/** The part of a record's (loose) spec that names a track. A value this build cannot read names no track. */
const MusicUse = z.looseObject({
  music: z.discriminatedUnion("source", [z.looseObject({ source: z.literal("trending"), trackId: Id }), z.looseObject({ source: z.literal("own"), mediaId: Id })]),
});

function keyOfSpec(spec: unknown): string | null {
  const parsed = MusicUse.safeParse(spec);
  if (!parsed.success) return null;
  const music = parsed.data.music;
  return music.source === "trending" ? trackKey("trending", music.trackId) : trackKey("own", music.mediaId);
}

/** The usage of the tracks by one avatar's videos, from the records in the library at `libraryRoot`. */
export async function trackUsage(libraryRoot: string, avatarId: string): Promise<TrackUsage> {
  const { records, skipped, truncated } = await readVideoRecordFiles(libraryRoot, avatarId);
  const counts = new Map<string, number>();
  const keys: (string | null)[] = [];
  for (const record of records) {
    const key = keyOfSpec(record.spec);
    keys.push(key);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // `records` is newest first; the last videos are the first of them, silent ones included.
  const recent = keys.slice(0, AUTOPILOT_RECENT_VIDEOS).filter((key): key is string => key !== null);
  return { counts, recent, complete: skipped === 0 && !truncated };
}
