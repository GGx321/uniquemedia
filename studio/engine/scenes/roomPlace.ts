import type { RoomPlace } from "./phoneLook";
import { POOLS } from "./pools";
import { CATEGORIES } from "./types";

// S5.1c: the lookup the room draw needs (phoneLook.ts roomStateOf takes an injected place). A slot stores its place and activity as plain text, so the place
// is found by name in today's built-in pools. Anything not found has no room phrase: a place renamed since an old plan was made, a place that is not a room,
// an own scene (no place) and a custom category (no room until 5a.2). Never an error.

/** The part of a slot the lookup reads; a scene-set `own` slot has no place or activity. */
export interface RoomSlotKey {
  category: string;
  location?: string | undefined;
  activity?: string | undefined;
}

/** The room a slot is in as the room draw reads it, or null when it has none. */
export function roomPlaceOf(slot: RoomSlotKey): RoomPlace | null {
  const category = CATEGORIES.find((c) => c === slot.category);
  if (category === undefined || slot.location === undefined) return null;
  const place = POOLS[category].locations.find((l) => l.name === slot.location);
  if (place === undefined || place.room !== true || place.details === undefined) return null;
  const activity = place.activities.find((a) => a.text === slot.activity);
  return { room: true, details: place.details, activity: { messyOk: activity?.messyOk === true } };
}
