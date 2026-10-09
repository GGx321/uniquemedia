import { useCallback, useEffect, useRef, useState } from "react";
import type { AvatarSummary, EngineError, PhotoSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { addedPhotos, advances, appendPage, CURSOR_STUCK, type PhotoPages, readThrough, readTop, type ReadPage, replacePhoto } from "./photoPages";
import { useMounted } from "./shared";

// S4.P2: an avatar's photos as a screen shows them (the «Фото» gallery, the editor's bin): read again whenever they may have changed,
// deeper on «Показать ещё». One read of photos.list at a time (review MEDIUM-1: with the autopilot running, reads that overlapped
// re-read every page the owner opened twice per photo): a reason to read again that comes meanwhile is kept, folded with any other,
// and read once, `REREAD_DEBOUNCE_MS` after the read in flight ends. A read never hangs the queue: main answers every command, by a
// timeout if need be. «Показать ещё» goes first (the owner is waiting on it); a re-read asked meanwhile reads down to the new page.

/** «Показать ещё»: nothing asked, the next page on its way, or its failure (until asked again). */
export type MoreState = { readonly status: "idle" } | { readonly status: "loading" } | { readonly status: "failed"; readonly error: EngineError };

const IDLE: MoreState = { status: "idle" };

/** How long a re-read asked while another read was in flight waits after it, for the next reasons to fold into it. */
const REREAD_DEBOUNCE_MS = 400;

/** What to read again: the top (new photos in front), or every page the owner opened (a change that may touch any). */
type Reread = "none" | "top" | "deep";

export interface PhotoPagesOptions {
  /** False while the engine cannot be asked (offline): nothing is read until it can, and then everything is. */
  readonly enabled: boolean;
  /** Values that change when a photo's state may have changed on any page (a mark, a render, the usage, a retry): a change re-reads every page opened. */
  readonly refresh: readonly unknown[];
  /** Values that change when new photos may have come in front (a run's photo landed): a change reads only the top. */
  readonly arrivals?: readonly unknown[];
  /** Each list as it is read, in the same update as the list: a reload (`added` null), or a «Показать ещё» with the photos it brought. */
  readonly onRead?: (list: PhotoPages, added: readonly PhotoSummary[] | null) => void;
}

export interface PhotoPagesView {
  /** Null until photos.list first answers. */
  readonly pages: PhotoPages | null;
  /** The last reload's failure: shown above whatever list is already on screen, never instead of it. */
  readonly error: EngineError | null;
  readonly more: MoreState;
  /** The photos the last «Показать ещё» brought, by id and in order; a new array each time (the focus goes to the first one shown). */
  readonly added: readonly string[] | null;
  readonly loadMore: () => void;
  /** A photo as the engine answered it since (a mark set): in its place, wherever its page. */
  readonly replace: (photo: PhotoSummary) => void;
}

/**
 * The two kinds of reasons in an avatar's summary (review MEDIUM-1): a new photo moves `photoCount` and `eligibleUnusedCount` by one
 * each, so their difference stands still — only the top needs reading. A mark, a video, a render or the usage moves the rest: every
 * page. (A batch where both kinds cancel out exactly is read at the top only; the next change of either kind reads it whole.)
 */
export function avatarPhotoKeys(avatar: AvatarSummary | null | undefined): { readonly states: string; readonly arrivals: string } {
  if (avatar == null) return { states: "none", arrivals: "none" };
  const usage = avatar.usage.state === "ok" ? "ok" : avatar.usage.reasons.join(",");
  return { states: `${avatar.videoCount}:${avatar.eligibleUnusedCount - avatar.photoCount}:${usage}`, arrivals: `${avatar.photoCount}` };
}

const sameValues = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** An avatar's photos (one avatar for the life of the component), paged. */
export function usePhotoPages(client: EngineClient, avatarId: string, { enabled, refresh, arrivals = [], onRead }: PhotoPagesOptions): PhotoPagesView {
  const [pages, setPages] = useState<PhotoPages | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [more, setMore] = useState<MoreState>(IDLE);
  const [added, setAdded] = useState<readonly string[] | null>(null);
  /** The list as last read, for the reads under way (state lags a render behind). */
  const held = useRef<PhotoPages | null>(null);
  /** A read of photos.list is in flight: the one at a time. */
  const busy = useRef(false);
  /** A re-read asked and not started yet (the deeper kind wins). */
  const pending = useRef<Reread>("none");
  /** The wait before a pending re-read, once a read ended. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** «Показать ещё» asked and not done yet. */
  const moreWanted = useRef(false);
  const mounted = useMounted();
  const readCallback = useRef(onRead);
  readCallback.current = onRead;

  const read: ReadPage = useCallback((cursor) => client.request("photos.list", cursor === null ? { avatarId } : { avatarId, cursor }), [client, avatarId]);
  const isCurrent = useCallback(() => mounted.current, [mounted]);

  const show = useCallback((list: PhotoPages, brought: readonly PhotoSummary[] | null): void => {
    held.current = list;
    setPages(list);
    readCallback.current?.(list, brought);
  }, []);

  // The queue: `next` starts whatever waits, when nothing is in flight; `settled` ends a read and lets the next one in.
  const next = useRef<() => void>(() => undefined);

  const settled = useCallback((): void => {
    busy.current = false;
    if (moreWanted.current) {
      next.current();
      return;
    }
    if (pending.current !== "none" && timer.current === null) {
      timer.current = setTimeout(() => {
        timer.current = null;
        next.current();
      }, REREAD_DEBOUNCE_MS);
    }
  }, []);

  const fetchMore = useCallback(async (): Promise<void> => {
    const list = held.current;
    const cursor = list?.nextCursor ?? null;
    if (cursor === null) {
      moreWanted.current = false;
      setMore(IDLE);
      return;
    }
    busy.current = true;
    const reply = await read(cursor);
    if (!isCurrent()) return;
    // Appended to the list as it is now, not as it was when asked (review LOW-1): a mark set meanwhile is kept. Only a reply that still
    // continues it is appended; one that does not (never, with one read at a time) is asked again.
    const now = held.current;
    if (now !== null && now.nextCursor === cursor) {
      moreWanted.current = false;
      if (!reply.ok) setMore({ status: "failed", error: reply.error });
      else if (!advances(cursor, reply.result)) setMore({ status: "failed", error: CURSOR_STUCK });
      else {
        const appended = appendPage(now, reply.result);
        const brought = addedPhotos(now, appended);
        show(appended, brought);
        setAdded(brought.map((p) => p.photoId));
        setMore(IDLE);
      }
    }
    settled();
  }, [read, isCurrent, show, settled]);

  const reread = useCallback(
    async (kind: "top" | "deep"): Promise<void> => {
      busy.current = true;
      const result = await (kind === "deep" ? readThrough : readTop)(read, held.current, isCurrent);
      if (result === null) return;
      if (result.ok) {
        show(result.list, null);
        setError(null);
        // A failed «Показать ещё» stays said until asked again, unless there is no next page left to ask for.
        if (result.list.nextCursor === null) setMore((state) => (state.status === "failed" ? IDLE : state));
      } else setError(result.error);
      settled();
    },
    [read, isCurrent, show, settled],
  );

  next.current = () => {
    if (busy.current || !mounted.current) return;
    if (moreWanted.current) {
      void fetchMore();
      return;
    }
    if (timer.current !== null || pending.current === "none") return;
    const kind = pending.current;
    pending.current = "none";
    void reread(kind);
  };

  /** A reason to read again: at once when nothing is in flight, else once after it (folded with any other meanwhile). */
  const ask = useCallback((kind: "top" | "deep"): void => {
    if (pending.current !== "deep") pending.current = kind;
    next.current();
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  // Which reasons moved since the last look decides the kind: the first look, the engine back, or a state reason, every page; a new
  // photo alone, the top. The caller's lists have a fixed length each, spread so that every value is compared on its own.
  const seen = useRef<{ enabled: boolean; refresh: readonly unknown[]; arrivals: readonly unknown[] } | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = { enabled, refresh, arrivals };
    if (!enabled) return;
    if (before === null || !before.enabled || !sameValues(before.refresh, refresh)) ask("deep");
    else if (!sameValues(before.arrivals, arrivals)) ask("top");
  }, [enabled, ask, ...refresh, ...arrivals]);

  const loadMore = useCallback((): void => {
    if (moreWanted.current) return;
    moreWanted.current = true;
    setMore({ status: "loading" });
    next.current();
  }, []);

  const replace = useCallback((photo: PhotoSummary): void => {
    const list = held.current;
    if (list === null) return;
    const changed = replacePhoto(list, photo);
    if (changed === list) return;
    held.current = changed;
    setPages(changed);
  }, []);

  return { pages, error, more, added, loadMore, replace };
}
