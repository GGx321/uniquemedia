import { type MontageDraft, type PhotoSummary, SceneCategory } from "../../../shared/engine";
import { photoCategoryLabel } from "../photos/runForm";
import { type AddRefusal, cellsOf } from "./clipOps";

/** What a scene photo carries as its category: a built-in, a custom category's id, or an own scene (the contract's `PhotoCategory`). */
export type BinCategory = PhotoSummary["category"];

// 3d.5: the «Фото» tab's bin (Editor.dc.html; the reconciliation's P6–P15), as pure data. Eligible scene photos only, numbered
// in the list's order (the numbers name the tiles and stay put while the chips filter). Each photo is placed in this draft (its
// clip's number is the slot badge, P10), free, or taken: one photo → one video (the owner, 2026-09-30, Q1), so a photo already
// in a video or in a queued or running render stays visible, dimmed, and cannot be added (P11).

/** The chips: «Неиспользованные» (free photos only, P7) and one category (P8); the avatar's chip is fixed (CF15). */
export interface BinFilter {
  readonly unusedOnly: boolean;
  readonly category: BinCategory | null;
}

/** `placed`: in this draft; `free`: may go in; `used`: in a video; `reserved`: in a queued or running render. */
export type BinState = "placed" | "free" | "used" | "reserved";

export interface BinTile {
  readonly photo: PhotoSummary;
  /** «Фото N»: its place among the bin's photos, whatever the chips show. */
  readonly n: number;
  /** The number of the first clip holding it, or null. */
  readonly slot: number | null;
  readonly state: BinState;
}

/** A photo that may go into the montage: eligible, and in no video and no render (one photo → one video, Q1). */
export function isFreePhoto(photo: PhotoSummary): boolean {
  return photo.eligible && !photo.used && !photo.reserved && photo.usedIn.length === 0;
}

/** Where each photo of the draft stands: the number of the first clip holding it. */
function slotsOf(spec: MontageDraft): ReadonlyMap<string, number> {
  const slots = new Map<string, number>();
  spec.clips.forEach((clip, i) => {
    for (const cell of cellsOf(clip)) if (cell.photo?.source === "scene" && !slots.has(cell.photo.photoId)) slots.set(cell.photo.photoId, i + 1);
  });
  return slots;
}

const stateOf = (photo: PhotoSummary, slot: number | null): BinState => (slot !== null ? "placed" : isFreePhoto(photo) ? "free" : photo.used || photo.usedIn.length > 0 ? "used" : "reserved");

/** Whether a photo passes the chips. */
const passes = (photo: PhotoSummary, filter: BinFilter, category = filter.category): boolean => (!filter.unusedOnly || isFreePhoto(photo)) && (category === null || photo.category === category);

/** The tiles the chips leave, in the list's order. */
export function binTiles(photos: readonly PhotoSummary[], spec: MontageDraft, filter: BinFilter): BinTile[] {
  const slots = slotsOf(spec);
  return photos
    .filter((photo) => photo.eligible)
    .map((photo, i) => {
      const slot = slots.get(photo.photoId) ?? null;
      return { photo, n: i + 1, slot, state: stateOf(photo, slot) };
    })
    .filter((tile) => passes(tile.photo, filter));
}

/** One category chip: its id, the name it is shown by, and how many photos it holds among those the other chip leaves. */
export interface BinFacet {
  readonly category: BinCategory;
  readonly label: string;
  readonly count: number;
}

const isBuiltIn = (category: BinCategory): boolean => SceneCategory.safeParse(category).success;

/**
 * The chips' counts: «Неиспользованные N» (the free eligible photos), and each category's photos among those the other chip
 * leaves. The categories are the ones the photos actually carry, so a custom category's or an own scene's photo is never hidden
 * from the filter: the five built-ins first in the contract's order, then the custom ones and the own scenes by label. A
 * category is shown by the label of its first photo in the list's order (the list is newest first, so a renamed category shows
 * its latest name). Only categories that have photos are offered, and the chosen one always (even at 0).
 */
export function binFacets(photos: readonly PhotoSummary[], filter: BinFilter): { unused: number; categories: BinFacet[] } {
  const eligible = photos.filter((photo) => photo.eligible);
  const labels = new Map<BinCategory, string>();
  for (const photo of eligible) if (!labels.has(photo.category)) labels.set(photo.category, photoCategoryLabel(photo));
  const carried = new Set<BinCategory>(labels.keys());
  if (filter.category !== null) carried.add(filter.category);
  const labelOf = (category: BinCategory): string => labels.get(category) ?? photoCategoryLabel({ category });
  const builtIns = SceneCategory.options.filter((category) => carried.has(category));
  const others = [...carried].filter((category) => !isBuiltIn(category)).sort((a, b) => labelOf(a).localeCompare(labelOf(b), "ru") || a.localeCompare(b));
  const categories = [...builtIns, ...others]
    .map((category) => ({ category, label: labelOf(category), count: eligible.filter((photo) => passes(photo, filter, category)).length }))
    .filter((c) => c.count > 0 || c.category === filter.category);
  return { unused: eligible.filter(isFreePhoto).length, categories };
}

/**
 * What a click on a tile does: `select` the clip a placed photo is in; nothing for a `taken` one (in a video or a render); a free
 * one `fill`s the empty cell waiting for it, or is `append`ed as a new clip, unless the draft is `full` (20 clips, or no 0.5 s
 * left of the 15 s).
 */
export type TileAction = "select" | "fill" | "append" | "taken" | "full";

export function tileAction(tile: BinTile, fillTarget: { readonly clip: number; readonly cell: number } | null, addBlock: AddRefusal | null): TileAction {
  if (tile.state === "placed") return "select";
  if (tile.state !== "free") return "taken";
  if (fillTarget !== null) return "fill";
  return addBlock === null ? "append" : "full";
}
