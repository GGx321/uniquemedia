import type { SceneRoute } from "../../shared/engine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import type { RoomPlace } from "./phoneLook";

// S5.1c: the lookup the room draw needs (phoneLook.ts roomStateOf takes an injected place). A slot stores its place and activity as plain text, so the place
// is found by name. Anything not found has no room phrase: a place renamed since an old plan was made, a place that is not a room, an own scene (no place) and
// a custom category stored before 5a.4 (no room until 5a.2). Never an error.
// 5a.4 (S5.BA3, I5.73, H1): the place is found by the ONE marker-aware lookup (`bankPlaceOf`), so a «Смелая» slot of the five reads its companion's room and details (never «Дом»'s) and a
// routed custom slot the shared bank's; a slot stored before 5a.4 has no route and reads the ordinary bank exactly as it did.

/** The part of a slot the lookup reads; a scene-set `own` slot has no place or activity. */
export interface RoomSlotKey {
  category: string;
  location?: string | undefined;
  activity?: string | undefined;
  /** The Seedream route, the marker of a «Смелая» frame of any category (I5.73). */
  route: SceneRoute | undefined;
}

/** The room a slot is in as the room draw reads it, or null when it has none. */
export function roomPlaceOf(slot: RoomSlotKey): RoomPlace | null {
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  if (hit === undefined || hit.place.room !== true) return null;
  return { room: true, details: hit.place.details, activity: { messyOk: hit.moment?.messyOk === true } };
}

/** What the look reads of a slot's place and moment, beyond the room draw (5a.2, S5.6b). */
export interface SlotLook {
  /** The place has a lamp: «Дом»'s lamp mood at evening and night (I5.34). */
  lamp: boolean;
  /** The moment is back or side to the mirror: only her reflection is in the picture (r1.5). */
  mirrorBack: boolean;
}

/** The lamp and back-to-the-mirror marks of a slot's place and moment, or null when the slot names neither a built-in place nor one of its moments (an own scene, a custom category, a renamed place). */
export function slotLookOf(slot: RoomSlotKey): SlotLook | null {
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  if (hit === undefined) return null;
  return { lamp: hit.place.lamp === true, mirrorBack: hit.moment?.mirrorBack === true };
}
