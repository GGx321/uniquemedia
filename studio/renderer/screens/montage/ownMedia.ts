import { useEffect, useState } from "react";
import type { MediaKind, MediaSummary, MontageDraft } from "../../../shared/engine";
import { ownPhotoCells, ownStickerCells, ownVideoClips } from "../../../shared/montage";
import type { EngineClient } from "../../engine/client";

// The editor's picture of the owner's own files its draft names (3f.5 for stickers, 3f.3b for videos): the records it needs, asked for BY ID
// (`media.list {kind, mediaIds}`, so a file older than the 500 newest the plain listing holds is still found) and kept current by `media.changed`.
// A kind's own view (`viewOf`) keeps what its part of the editor uses of a record. What the window knows of an id is one of three things:
// - held: the library holds it as this kind (its view);
// - answered and not held: the library said it does not (an answer without it, or a `removed` event since): the draft's reference is dangling;
// - not answered: the list has not come yet, or could not be read: nothing is said about it.

/** What `media.changed` says: a record stored or replaced, or one gone. */
export type MediaChange = { readonly change: "upserted"; readonly media: MediaSummary } | { readonly change: "removed"; readonly mediaId: string };

export interface MediaRecords<T> {
  /** The records the library holds, by media id. */
  readonly held: ReadonlyMap<string, T>;
  /** The ids the library has answered for: one of them that is not held is not in the library (as this kind). */
  readonly answered: ReadonlySet<string>;
}

export const NO_RECORDS: MediaRecords<never> = { held: new Map<string, never>(), answered: new Set<string>() };

/** Every own file the draft names (3f.3b fix round 1, M1): the own photos in its cells, its own video clips, its own sticker layers and an own track. */
export function draftMediaIds(spec: MontageDraft): ReadonlySet<string> {
  const ids = [...ownPhotoCells(spec), ...ownVideoClips(spec), ...ownStickerCells(spec)].map((cell) => cell.mediaId);
  if (spec.music?.source === "own") ids.push(spec.music.mediaId);
  return new Set(ids);
}

/** Whether a `media.changed` is about one of `ids` (removed or stored again): the engine's verdict on a draft naming it may have changed. */
export function changeTouches(change: MediaChange, ids: ReadonlySet<string>): boolean {
  return ids.has(change.change === "removed" ? change.mediaId : change.media.mediaId);
}

/** The held map after one change; the same map when the change is not about this kind or about a record it never held. Never edits the map it is given. */
export function applyHeldChange<T extends { readonly mediaId: string }>(held: ReadonlyMap<string, T>, change: MediaChange, viewOf: (summary: MediaSummary) => T | null): ReadonlyMap<string, T> {
  if (change.change === "removed") {
    if (!held.has(change.mediaId)) return held;
    const next = new Map(held);
    next.delete(change.mediaId);
    return next;
  }
  const view = viewOf(change.media);
  if (view === null) return held;
  return new Map(held).set(view.mediaId, view);
}

/** The records after one change: a record of this kind stored is held and answered, one held and removed is answered and no longer held; else the same object. */
export function applyRecordsChange<T extends { readonly mediaId: string }>(records: MediaRecords<T>, change: MediaChange, viewOf: (summary: MediaSummary) => T | null): MediaRecords<T> {
  const held = applyHeldChange(records.held, change, viewOf);
  if (held === records.held) return records;
  const id = change.change === "removed" ? change.mediaId : change.media.mediaId;
  return { held, answered: records.answered.has(id) ? records.answered : new Set(records.answered).add(id) };
}

/**
 * The records of kind `kind` the draft names (`mediaIds`), asked by id and followed by `media.changed`. Nothing is held or answered until the answer
 * arrives, nor when it cannot be had (a refused or failed list): every id is then unknown. Nothing is asked while the draft names none; the ids are asked
 * in sorted order, each once, so the same set in another order is not another question. `viewOf` must be a stable function (a module's own).
 */
export function useMediaRecords<T extends { readonly mediaId: string }>(
  client: Pick<EngineClient, "request" | "subscribe">,
  kind: MediaKind,
  mediaIds: readonly string[],
  viewOf: (summary: MediaSummary) => T | null,
): MediaRecords<T> {
  const [records, setRecords] = useState<MediaRecords<T>>(NO_RECORDS);
  const key = [...new Set(mediaIds)].sort().join("\n");
  useEffect(() => {
    let alive = true;
    const ids = key === "" ? [] : key.split("\n");
    // Events that arrive before the answer does are kept and applied after it, so none is lost to the race.
    const early: MediaChange[] = [];
    let listed = ids.length === 0;
    const settle = (start: MediaRecords<T>): void => {
      if (!alive) return;
      listed = true;
      let next = start;
      for (const change of early.splice(0)) next = applyRecordsChange(next, change, viewOf);
      setRecords(next);
    };
    const unsubscribe = client.subscribe((event) => {
      if (event.type !== "media.changed") return;
      if (!listed) early.push(event.payload);
      else if (alive) setRecords((current) => applyRecordsChange(current, event.payload, viewOf));
    });
    if (ids.length > 0) {
      void client.request("media.list", { kind, mediaIds: ids }).then(
        (reply) => {
          if (!reply.ok) {
            settle(NO_RECORDS);
            return;
          }
          const held = new Map<string, T>();
          for (const media of reply.result.media) {
            const view = viewOf(media);
            if (view !== null) held.set(view.mediaId, view);
          }
          settle({ held, answered: new Set(ids) });
        },
        // The engine could not be asked: nothing is known, and what arrived meanwhile is applied to that.
        () => settle(NO_RECORDS),
      );
    }
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [client, key, kind, viewOf]);
  return records;
}
