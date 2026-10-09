import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import type { EngineError, MediaSummary, MontageDraft } from "../../../shared/engine";
import type { DropReply, EngineClient } from "../../engine/client";
import { type ImportView, importPercent, isActiveImport } from "../../engine/importJobs";
import { useEngine, useEngineView } from "../../engine/react";
import type { EngineStore, MediaStoreChange } from "../../engine/store";
import { errorText } from "../../lib/errors";
import { ownPhotoUrl, ownStickerUrl, ownTrackUrl, ownVideoUrl, placeholderGradient } from "../../lib/media";
import { Icon, PauseIcon, PlayIcon, Spin } from "../../ui/Icon";
import { cancelOnEscape, useConfirmFocus } from "../../ui/useConfirmFocus";
import { useMounted } from "../photos/shared";
import { type AddRefusal, totalMs } from "./clipOps";
import {
  applyLibraryChange,
  type BinDrag,
  deleteConfirmText,
  deleteRefusalText,
  dropSummary,
  type FillTarget,
  importCard,
  importFailure,
  importTileLabel,
  isFileDrag,
  lengthClock,
  livePosters,
  MAX_LIVE_POSTERS,
  MAX_POSTERS,
  type MineLibrary,
  mineHint,
  mineSections,
  nextListening,
  type PickOutcome,
  PosterZones,
  pickOutcomeText,
  type StickerTile,
  stickerAria,
  type TrackTile,
  trackRowAria,
  trackRowNote,
  trackRowTitle,
  type VisualTile,
  visualAria,
  visualTitle,
} from "./mine";
import { realScheduler } from "../../engine/scheduler";
import type { PlayheadStore } from "./playhead";

// 3f.6: the «Мои» tab (EditorMine.dc.html, the components sheet's drop zone and its import, normalising and refusal states; the
// reconciliation's M1–M15). The drop zone opens MAIN's own dialog (`media.pickImport {kind: "any"}`: the window sends a kind and nothing
// else), and takes files dragged from Finder or Explorer (M13, round 2, the owner's decision of 2026-10-04): the dropped `File` objects go to
// the client's drop door and nothing else (the preload maps them to the paths the OS gave them; main takes those as its own dialog's picks).
// Under it, the import that runs now (copying, or preparing a video, «HDR → SDR, 60 → 30 fps»), a pick's or a drop's refusals and the imports
// that failed, each said in its kind's own words. Then the owner's files: photos and videos (a click places one by the «Фото» tab's rules, a
// drag inserts one), music (listen, pick), stickers (at the playhead). Every file can be deleted, after a confirmation; one a queued or running
// render uses is refused, and said so.

type ListState = { readonly state: "loading" } | { readonly state: "ready"; readonly library: MineLibrary } | { readonly state: "failed"; readonly error: EngineError };

/**
 * The library listing (`media.list`, newest first): asked when the tab opens, again for another engine or library folder (`key`) and after the
 * store's snapshot taken again (`resynced`: the changes in the gap are lost), and kept current by `media.changed` in seq order (the store's
 * media listeners). Changes heard before the answer are applied to it. The last listing stays while the same library is listed again.
 */
export function useMineLibrary(client: Pick<EngineClient, "request">, store: Pick<EngineStore, "subscribeMedia">, key: string): { list: ListState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<ListState>({ state: "loading" });
  const listedKey = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    let listed = false;
    const early: MediaStoreChange[] = [];
    // Another library (or engine): what was listed belongs to the old one and is never shown for the new one.
    if (listedKey.current !== key) setList({ state: "loading" });
    const stop = store.subscribeMedia((signal) => {
      if (!alive) return;
      if (signal.change === "resynced") {
        setAttempt((n) => n + 1);
        return;
      }
      if (!listed) early.push(signal);
      else setList((now) => (now.state === "ready" ? { state: "ready", library: applyLibraryChange(now.library, signal) } : now));
    });
    void client.request("media.list", {}).then((reply) => {
      if (!alive) return;
      listed = true;
      if (!reply.ok) {
        setList({ state: "failed", error: reply.error });
        return;
      }
      listedKey.current = key;
      const library = early.splice(0).reduce(applyLibraryChange, { media: reply.result.media, total: reply.result.total });
      setList({ state: "ready", library });
    });
    return () => {
      alive = false;
      stop();
    };
  }, [client, store, key, attempt]);
  return {
    list,
    retry: () => {
      setList({ state: "loading" });
      setAttempt((n) => n + 1);
    },
  };
}

export interface MineTabProps {
  readonly spec: MontageDraft;
  /** The editor's playhead: listening to a track stops a playback, and a playback stops the listening (L5: one sound at a time). */
  readonly playhead: PlayheadStore;
  /** The selected clip's empty cell a photo click fills; null when none waits. */
  readonly fillTarget: FillTarget;
  /** Why no clip can be added (20 clips, no room left of the 15 s). */
  readonly addBlock: AddRefusal | null;
  /** Why no sticker can be added at the playhead now (the cap, no room); null when it can. */
  readonly stickerWhy: string | null;
  /** The selected layer's own sticker, ringed. */
  readonly selectedSticker: string | null;
  /** A photo or video tile clicked: select its clip, fill the waiting cell, or a new clip at the end. */
  readonly onPickVisual: (media: MediaSummary) => void;
  /** A photo or video dragged out of the tab (onto «Кадры» or an empty cell), or null when the drag ends. */
  readonly onDragVisual: (drag: BinDrag | null) => void;
  /** A track row clicked (never one shorter than the montage, but the montage's own track always: it selects the music). */
  readonly onPickTrack: (media: MediaSummary) => void;
  /** A sticker tile clicked: a layer at the playhead. */
  readonly onPickSticker: (mediaId: string) => void;
}

const dragOf = (media: MediaSummary): BinDrag | null =>
  media.kind === "photo" ? { source: "own", kind: "photo", mediaId: media.mediaId } : media.kind === "video" ? { source: "own", kind: "video", mediaId: media.mediaId, durationMs: media.durationMs ?? 0 } : null;

/**
 * A video tile's poster (round 1, M1): the stored mezzanine's first frame, muted (its sound is never used, V4). When the tile goes, the element
 * lets go of the file and its decoder at once (paused, no source, loaded again), as the preview's video does, rather than when it is collected.
 */
export function PosterVideo({ url, onFail }: { url: string; onFail: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.src = url;
    return () => {
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  return <video ref={ref} className="mine-pic" muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} onError={onFail} />;
}

/** A photo or video tile's picture: the stored file through main's media route (an element shows it, nothing reads it), or a stand-in. */
function VisualPicture({ media, live }: { media: MediaSummary; live: boolean }) {
  const { client } = useEngine();
  const [failed, setFailed] = useState(false);
  const url = media.kind === "photo" ? ownPhotoUrl(client, media.mediaId) : live ? ownVideoUrl(client, media.mediaId) : null;
  // A new source (a poster given back to a tile that left the view) is tried again (round 2).
  useEffect(() => setFailed(false), [url]);
  if (url === null || failed) {
    return (
      <span className={media.kind === "video" ? "mine-pic mine-pic-video" : "mine-pic"} style={media.kind === "photo" ? { background: placeholderGradient(media.mediaId) } : undefined} aria-hidden="true">
        {media.kind === "video" && <Icon name="film" size={18} strokeWidth={1.6} />}
      </span>
    );
  }
  return media.kind === "photo" ? (
    <img className="mine-pic" src={url} alt="" draggable={false} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  ) : (
    <PosterVideo url={url} onFail={() => setFailed(true)} />
  );
}

/** A tile whose import is on its way (M6): the spinner while it runs, and «40 %», «в очереди» or «отменяем». */
function BusyMark({ view }: { view: ImportView }) {
  return (
    <span className={view.status === "queued" ? "mine-busy mine-busy-wait" : "mine-busy"} aria-hidden="true">
      {view.status === "running" && !view.cancelRequested && <span className="spin" />}
      <span className="mine-busy-label">{importTileLabel(view)}</span>
    </span>
  );
}

/** The ✕ on a tile or row whose import is on its way: `media.cancelImport`. */
function CancelImport({ view, onCancel }: { view: ImportView; onCancel: (view: ImportView) => void }) {
  return (
    <button type="button" className="mine-x" aria-label={`Отменить добавление ${view.name}`} disabled={view.cancelRequested} onClick={() => onCancel(view)}>
      <Icon name="close" size={11} strokeWidth={2.6} />
    </button>
  );
}

/** A tile's or a row's trash asks for its file's delete; `from` is the trash, where the focus goes back when the owner cancels (slice review 5-M4). */
type AskDelete = (media: MediaSummary, from: HTMLElement) => void;

function DeleteButton({ media, onDelete }: { media: MediaSummary; onDelete: AskDelete }) {
  return (
    <button type="button" className="mine-del" aria-label={`Удалить ${media.name}`} title="Удалить" onClick={(e) => onDelete(media, e.currentTarget)}>
      <Icon name="trash" size={12} strokeWidth={2.2} />
    </button>
  );
}

function VisualTileView({
  tile,
  live,
  fillTarget,
  onPick,
  onDrag,
  onDelete,
  onCancel,
  hintId,
}: {
  tile: VisualTile;
  live: boolean;
  fillTarget: FillTarget;
  onPick: (media: MediaSummary) => void;
  onDrag: (drag: BinDrag | null) => void;
  onDelete: AskDelete;
  onCancel: (view: ImportView) => void;
  hintId: string;
}) {
  if (tile.kind === "import") {
    const { view } = tile;
    return (
      <li className="ph mine-tile mine-tile-busy" aria-label={`${view.mediaKind === "video" ? "Видео" : "Фото"} ${view.name}: ${view.status === "queued" ? "в очереди" : `добавляется, ${importPercent(view)} %`}`}>
        <div className="shim" />
        <BusyMark view={view} />
        <CancelImport view={view} onCancel={onCancel} />
      </li>
    );
  }
  const { media, slot, action } = tile;
  const drag = action === "too-short" ? null : dragOf(media);
  return (
    <li className={["ph mine-tile", slot !== null ? "mine-tile-in" : "", action === "too-short" ? "mine-tile-off" : ""].filter(Boolean).join(" ")} data-poster={media.kind === "video" ? media.mediaId : undefined}>
      <button
        type="button"
        className="mine-pick"
        aria-label={visualAria(tile, fillTarget)}
        aria-describedby={hintId}
        title={visualTitle(tile)}
        disabled={action === "full" || action === "too-short"}
        draggable={drag !== null}
        onClick={() => onPick(media)}
        onDragStart={(e) => {
          if (drag === null) return;
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "copy";
            // Chromium needs some data to start a drag; the file itself travels in renderer state.
            e.dataTransfer.setData("text/plain", media.name);
          }
          onDrag(drag);
        }}
        onDragEnd={() => onDrag(null)}
      >
        <VisualPicture media={media} live={live} />
      </button>
      {media.kind === "video" && (
        <span className="ctag mine-dur">
          <PlayIcon size={8} />
          {lengthClock(media.durationMs ?? 0)}
        </span>
      )}
      {slot !== null && <span className="mono mine-slot">{slot}</span>}
      <DeleteButton media={media} onDelete={onDelete} />
    </li>
  );
}

/**
 * S4.9c: «для автопилота» on an own track (LaunchStates «Музыка», the tab «Мои» of «Монтаж»): the autopilot may put the track in its videos. A free mark the
 * library keeps (`media.setForAutopilot`), never the montage's: the track goes into this draft as before, by a click on its row. A track the render cannot
 * read (not stored as an m4a) is refused by the engine, and the chip says so from then on.
 */
function AutopilotFlag({ media, onError }: { media: MediaSummary; onError: (error: EngineError) => void }) {
  const { client } = useEngine();
  const mounted = useMounted();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const on = media.forAutopilot === true && !refused;
  const toggle = async (): Promise<void> => {
    setBusy(true);
    const reply = await client.request("media.setForAutopilot", { mediaId: media.mediaId, on: !on });
    if (!mounted.current) return;
    setBusy(false);
    // The row follows `media.changed`; only a refusal is this chip's to say.
    if (reply.ok) return;
    if (reply.error.code === "MEDIA_UNSUPPORTED") setRefused(true);
    else onError(reply.error);
  };
  return (
    <button
      type="button"
      className={on ? "chip chip-on mine-ap" : "chip mine-ap"}
      aria-pressed={on}
      aria-label={`Для автопилота: ${media.name}`}
      aria-disabled={refused || busy || undefined}
      aria-busy={busy || undefined}
      title={refused ? "Автопилот берёт только m4a с известной длиной" : undefined}
      onClick={refused || busy ? undefined : () => void toggle()}
    >
      {on && <Icon name="bolt" size={10} />}
      для автопилота
    </button>
  );
}

function TrackRowView({
  row,
  montageMs,
  listening,
  onListen,
  onPick,
  onDelete,
  onCancel,
  onFlagError,
}: {
  row: TrackTile;
  montageMs: number;
  listening: string | null;
  onListen: (mediaId: string) => void;
  onPick: (media: MediaSummary) => void;
  onDelete: AskDelete;
  onCancel: (view: ImportView) => void;
  onFlagError: (error: EngineError) => void;
}) {
  const { client } = useEngine();
  if (row.kind === "import") {
    const { view } = row;
    return (
      <li className="mine-track mine-track-busy" aria-label={`Трек ${view.name}: ${view.status === "queued" ? "в очереди" : `добавляется, ${importPercent(view)} %`}`}>
        <span className="mine-listen mine-listen-busy" aria-hidden="true">
          {view.status === "running" && !view.cancelRequested ? <span className="spin" /> : <Icon name="music" size={12} />}
        </span>
        <span className="mine-track-body">
          <span className="mine-track-name">{view.name}</span>
          <span className="mono faint mine-track-note">{importTileLabel(view)}</span>
        </span>
        <CancelImport view={view} onCancel={onCancel} />
      </li>
    );
  }
  const { media, tooShort, inDraft, pickable } = row;
  const playing = listening === media.mediaId;
  const canListen = ownTrackUrl(client, media.mediaId) !== null;
  return (
    <li className={["mine-track", inDraft ? "mine-track-on" : "", tooShort ? "mine-track-off" : ""].filter(Boolean).join(" ")}>
      <button
        type="button"
        className={playing ? "mine-listen mine-listen-on" : "mine-listen"}
        aria-label={`${playing ? "Остановить" : "Послушать"} ${media.name}`}
        aria-pressed={playing}
        disabled={!canListen}
        title={canListen ? undefined : "Прослушать нельзя: звук этого файла недоступен"}
        onClick={() => onListen(media.mediaId)}
      >
        {playing ? <PauseIcon size={11} /> : <PlayIcon size={11} />}
      </button>
      <button
        type="button"
        className="mine-track-pick"
        aria-label={trackRowAria(row, montageMs)}
        aria-current={inDraft ? "true" : undefined}
        aria-disabled={pickable ? undefined : "true"}
        title={trackRowTitle(row)}
        onClick={() => {
          if (pickable) onPick(media);
        }}
      >
        <span className="mine-track-name">{media.name}</span>
        <span className={inDraft ? "mono mine-track-note mine-track-note-on" : "mono faint mine-track-note"}>{trackRowNote(row)}</span>
      </button>
      <AutopilotFlag media={media} onError={onFlagError} />
      <DeleteButton media={media} onDelete={onDelete} />
    </li>
  );
}

function StickerTileView({ tile, blocked, why, onPick, onDelete, onCancel }: { tile: StickerTile; blocked: boolean; why: string | null; onPick: (mediaId: string) => void; onDelete: AskDelete; onCancel: (view: ImportView) => void }) {
  const { client } = useEngine();
  if (tile.kind === "import") {
    const { view } = tile;
    return (
      <li className="mine-stk" aria-label={`Стикер ${view.name}: ${view.status === "queued" ? "в очереди" : `добавляется, ${importPercent(view)} %`}`}>
        <div className="stk ph mine-stk-busy">
          <div className="shim" />
          <BusyMark view={view} />
        </div>
        <CancelImport view={view} onCancel={onCancel} />
      </li>
    );
  }
  const { media, uses, on } = tile;
  // The stored GIF or APNG as an element shows it, playing its own loop (3f.5's `ownStickerUrl`; the dev mock's stand-in): no pixel is read.
  const url = ownStickerUrl(client, media.mediaId);
  return (
    <li className="mine-stk">
      <button type="button" className={on ? "stk stk-on" : "stk"} aria-label={stickerAria(tile)} title={blocked ? (why ?? undefined) : media.name} disabled={blocked} onClick={() => onPick(media.mediaId)}>
        {url === null ? <Icon name="sparkle" size={20} /> : <img src={url} alt="" draggable={false} />}
        {uses > 0 && <span className="mono stk-count">{uses}</span>}
      </button>
      <DeleteButton media={media} onDelete={onDelete} />
    </li>
  );
}

/**
 * Where the video tiles are (rounds 1 and 2, M1): two IntersectionObservers on the tab's own scroll area, one for what is seen (no margin) and one
 * for a screen of margin around it, their reports coalesced (`PosterZones`: at most one update per 150 ms while scrolling). `livePosters` then
 * gives the visible tiles a poster (up to its ceiling) and the nearest margin tiles the rest. Where nothing reports (no observer), every tile counts
 * as visible.
 */
function usePosterZones(root: { readonly current: HTMLElement | null }, ids: readonly string[]): { visible: ReadonlySet<string>; near: ReadonlySet<string> } {
  const [zones, setZones] = useState<{ visible: ReadonlySet<string>; near: ReadonlySet<string> }>(() => ({ visible: new Set(), near: new Set() }));
  const key = ids.join("\n");
  useEffect(() => {
    const scroller = root.current;
    if (scroller === null) return;
    if (typeof IntersectionObserver === "undefined") {
      const all = new Set(key === "" ? [] : key.split("\n"));
      setZones({ visible: all, near: all });
      return;
    }
    const posterZones = new PosterZones(realScheduler, (visible, near) => setZones({ visible, near }));
    const observe = (zone: "visible" | "near", rootMargin: string): IntersectionObserver => {
      const observer = new IntersectionObserver(
        (entries) =>
          posterZones.report(
            zone,
            entries.flatMap((entry) => {
              const id = entry.target.getAttribute("data-poster");
              return id === null ? [] : [{ id, isIntersecting: entry.isIntersecting }];
            }),
          ),
        { root: scroller, rootMargin },
      );
      for (const tile of scroller.querySelectorAll("[data-poster]")) observer.observe(tile);
      return observer;
    };
    const observers = [observe("visible", "0px"), observe("near", "100% 0px")];
    return () => {
      for (const observer of observers) observer.disconnect();
      posterZones.dispose();
    };
  }, [root, key]);
  return zones;
}

export function MineTab({ spec, playhead, fillTarget, addBlock, stickerWhy, selectedSticker, onPickVisual, onDragVisual, onPickTrack, onPickSticker }: MineTabProps) {
  const { client, store } = useEngine();
  const view = useEngineView();
  const mounted = useMounted();
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const offline = client.kind === "unavailable" || view.phase === "offline";
  const { list, retry } = useMineLibrary(client, store, `${view.bootId ?? ""}\n${view.settings?.libraryPath ?? ""}`);

  // ---------- the pick (M1), the drop (M13) and their result (M15) ----------
  const [picking, setPicking] = useState(false);
  const [outcome, setOutcome] = useState<PickOutcome | null>(null);
  const [pickError, setPickError] = useState<{ title: string; error: EngineError } | null>(null);
  /** Files dragged over the zone now: what it will take. */
  const [over, setOver] = useState<ReturnType<typeof dropSummary>>(null);
  const importDropped = client.importDropped;
  const canDrop = importDropped !== undefined && !offline && !picking;

  function settle(reply: DropReply, title: string): void {
    if (!reply.ok) setPickError({ title, error: reply.error });
    else if (reply.result.picked) setOutcome({ jobIds: reply.result.jobIds, refused: reply.result.refused, skipped: reply.result.skipped });
  }

  async function pick(): Promise<void> {
    if (picking) return;
    setPicking(true);
    setPickError(null);
    const reply = await client.request("media.pickImport", { kind: "any" });
    if (!mounted.current) return;
    setPicking(false);
    settle(reply.ok ? { ok: true, result: reply.result } : reply, "Окно выбора файлов не открылось");
  }

  async function drop(files: readonly File[]): Promise<void> {
    if (importDropped === undefined || picking || files.length === 0) return;
    setPicking(true);
    setPickError(null);
    const reply = await importDropped(files);
    if (!mounted.current) return;
    setPicking(false);
    settle(reply, "Перетащенные файлы не добавились");
  }

  /** A drag over the zone: only files are taken, and only when the zone can take them; the browser's own handling (open the file) never happens. */
  function onDragOver(event: DragEvent<HTMLButtonElement>): void {
    const transfer = event.dataTransfer;
    if (!isFileDrag([...transfer.types])) return;
    event.preventDefault();
    transfer.dropEffect = canDrop ? "copy" : "none";
    setOver(canDrop ? dropSummary([...transfer.items].map((item) => ({ kind: item.kind, type: item.type }))) : null);
  }

  function onDragLeave(event: DragEvent<HTMLButtonElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOver(null);
  }

  function onDrop(event: DragEvent<HTMLButtonElement>): void {
    const transfer = event.dataTransfer;
    if (!isFileDrag([...transfer.types])) return;
    event.preventDefault();
    setOver(null);
    if (canDrop) void drop([...transfer.files]);
  }

  // ---------- the imports on their way (M6, M14) ----------
  const [cancelError, setCancelError] = useState<EngineError | null>(null);
  async function cancel(target: ImportView): Promise<void> {
    // Marked BEFORE the command goes (round 1, L1): the job's end may beat the answer, and it is still the owner's own cancel.
    store.askImportCancel(target.jobId);
    const reply = await client.request("media.cancelImport", { jobId: target.jobId });
    if (reply.ok) return;
    // Refused: the import goes on, and says so again.
    store.cancelRefused(target.jobId);
    if (mounted.current) setCancelError(reply.error);
  }
  const imports = view.imports;
  const running = imports.find((i) => i.status === "running");
  const waiting = imports.filter((i) => i.status === "queued").length;
  const failures = imports.flatMap((i) => {
    const text = importFailure(i);
    return text === null ? [] : [{ jobId: i.jobId, ...text }];
  });
  const result = outcome === null ? null : pickOutcomeText(outcome, imports);

  // ---------- listen (M9): one track at a time, and one sound in the editor (L5) ----------
  const audio = useRef<HTMLAudioElement>(null);
  const [listening, setListening] = useState<string | null>(null);
  /** S4.9c: «для автопилота» refused for another reason than the track's format. */
  const [flagError, setFlagError] = useState<EngineError | null>(null);
  useEffect(() => {
    const element = audio.current;
    if (element === null) return;
    const url = listening === null ? null : ownTrackUrl(client, listening);
    if (url === null) {
      element.pause();
      return;
    }
    // The preview's playback stops: one sound at a time.
    if (playhead.get().playing) playhead.toggle();
    element.src = url;
    element.currentTime = 0;
    element.play()?.catch(() => {
      if (mounted.current) setListening(null);
    });
  }, [listening, client, mounted, playhead]);
  // A playback started (the timeline's «Воспроизвести», a key): the listening stops.
  useEffect(() => playhead.subscribe(() => {
    if (playhead.get().playing) setListening(null);
  }), [playhead]);
  useEffect(() => {
    const element = audio.current;
    return () => {
      if (element === null) return;
      element.pause();
      // The file and its decoder are let go now, not when the element is collected.
      element.removeAttribute("src");
      element.load();
    };
  }, []);

  // ---------- delete ----------
  /** The file whose delete is asked about, the trash that asked (`from`), and the engine's refusal once it came. */
  const [confirm, setConfirm] = useState<{ media: MediaSummary; from: HTMLElement | null; refusal: string | null } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLButtonElement>(null);
  // Slice review 5-M4: the confirmation sits above the sections, far from the tile that asked: the focus goes to its «Отмена» (Settings' pattern),
  // back to that tile's trash when it is cancelled, and to «Добавить файлы» once the file (and its trash) is gone.
  const confirmFocus = useConfirmFocus();
  useEffect(() => {
    if (confirm !== null) confirmRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [confirm]);
  function askDelete(media: MediaSummary, from: HTMLElement): void {
    setConfirm({ media, from, refusal: null });
    confirmFocus.opened();
  }
  function closeConfirm(): void {
    const from = confirm?.from ?? null;
    setConfirm(null);
    confirmFocus.moveTo(() => (from?.isConnected === true ? from : dropRef.current));
  }
  async function remove(media: MediaSummary): Promise<void> {
    setDeleting(true);
    const reply = await client.request("media.delete", { mediaId: media.mediaId });
    if (!mounted.current) return;
    setDeleting(false);
    if (reply.ok) {
      setConfirm(null);
      confirmFocus.moveTo(() => dropRef.current);
      if (listening === media.mediaId) setListening(null);
    } else {
      setConfirm((now) => ({ media, from: now?.from ?? null, refusal: deleteRefusalText(reply.error, media.name) }));
      confirmFocus.opened();
    }
  }

  const library = list.state === "ready" ? list.library : { media: [], total: 0 };
  const sections = mineSections(library, imports, spec, { fillTarget, addBlock, selectedSticker });
  const empty = list.state === "ready" && library.media.length === 0 && !imports.some(isActiveImport);
  const montageMs = totalMs(spec);
  const confirmText = confirm === null ? null : deleteConfirmText(confirm.media, spec);
  // M1: the video tiles in view hold a live poster (at most MAX_POSTERS), and those near it fill up to MAX_LIVE_POSTERS.
  const videoIds = sections.visual.flatMap((t) => (t.kind === "record" && t.media.kind === "video" ? [t.media.mediaId] : []));
  const zones = usePosterZones(scroller, videoIds);
  const live = livePosters(videoIds, zones.visible, zones.near, MAX_LIVE_POSTERS, MAX_POSTERS);

  return (
    <div ref={scroller} className="mine">
      <button
        ref={dropRef}
        type="button"
        className={over !== null ? "drop drop-over" : "drop"}
        aria-busy={picking}
        disabled={offline || picking}
        onClick={() => void pick()}
        onDragEnter={onDragOver}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="drop-ic">{picking ? <Spin /> : <Icon name="upload" size={18} />}</span>
        {over !== null ? (
          <span className="drop-text">
            <span className="drop-title">{over.title}</span>
            <span className="faint drop-sub">{over.detail}</span>
          </span>
        ) : (
          <span className="drop-text">
            <span className="drop-title">Добавить файлы</span>
            <span className="faint drop-sub">фото, видео, музыка, стикеры · перетащите или нажмите</span>
          </span>
        )}
      </button>

      {offline && (
        <p className="mine-note mine-note-warn" role="status">
          <Icon name="alert" size={14} />
          Движок Studio недоступен: свои файлы сейчас не добавить и не удалить.
        </p>
      )}

      {running !== undefined && <MineStatus view={running} queued={waiting} onCancel={(v) => void cancel(v)} />}

      {pickError !== null && <MineAlert title={pickError.title} body={errorText(pickError.error)} onClose={() => setPickError(null)} />}
      {cancelError !== null && <MineAlert title="Не удалось отменить" body={errorText(cancelError)} onClose={() => setCancelError(null)} />}
      {result !== null && <MineAlert title={result.title} body={[...result.lines, ...(result.rest === null ? [] : [result.rest])]} onClose={() => setOutcome(null)} />}
      {failures.map((f) => (
        <MineAlert key={f.jobId} title={f.title} body={f.body} onClose={() => store.dismissImport(f.jobId)} />
      ))}

      {confirm !== null && confirmText !== null && (
        <div ref={confirmRef} className="mine-confirm" role="alert" onKeyDown={(e) => cancelOnEscape(e, closeConfirm, deleting)}>
          {confirm.refusal === null ? (
            <>
              <span className="mine-confirm-title">{confirmText.title}</span>
              <span className="mine-confirm-body">{confirmText.body}</span>
              <div className="mine-confirm-actions">
                <button type="button" className="btn btn-s btn-d" aria-busy={deleting} disabled={deleting || offline} onClick={() => void remove(confirm.media)}>
                  {deleting && <Spin />}
                  Удалить
                </button>
                <button ref={confirmFocus.cancelRef} type="button" className="btn btn-s" disabled={deleting} onClick={closeConfirm}>
                  Отмена
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="mine-confirm-body">{confirm.refusal}</span>
              <div className="mine-confirm-actions">
                <button ref={confirmFocus.cancelRef} type="button" className="btn btn-s" onClick={closeConfirm}>
                  Понятно
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {list.state === "loading" ? (
        <div className="mine-sections" aria-hidden="true">
          <span className="lbl">Фото и видео</span>
          <div className="mine-grid">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="ph mine-tile">
                <div className="shim" />
              </div>
            ))}
          </div>
        </div>
      ) : list.state === "failed" ? (
        <div className="mine-empty" role="alert">
          <p className="muted">Не удалось прочитать свои файлы. {errorText(list.error)}</p>
          <button type="button" className="btn btn-s" onClick={retry}>
            Повторить
          </button>
        </div>
      ) : empty ? (
        <div className="mine-empty">
          <span className="mine-empty-ic" aria-hidden="true">
            <Icon name="folder" size={20} strokeWidth={1.7} />
          </span>
          <p className="mine-empty-title">Своих файлов пока нет</p>
          <p className="faint">Фото и видео станут кадрами, музыка — треком ролика, анимированные GIF и APNG — стикерами. Перетащите файлы сюда или нажмите «Добавить файлы». Studio хранит у себя копию, исходный файл не трогает.</p>
        </div>
      ) : (
        <div className="mine-sections">
          <section className="mine-section" aria-label="Фото и видео">
            <span className="lbl">
              Фото и видео <span className="mono">· {sections.counts.visual}</span>
            </span>
            {sections.visual.length === 0 ? (
              <p className="faint mine-none">Своих фото и видео пока нет.</p>
            ) : (
              <ul className="mine-grid" aria-label="Свои фото и видео">
                {sections.visual.map((tile) => (
                  <VisualTileView
                    key={tile.kind === "import" ? tile.view.jobId : tile.media.mediaId}
                    tile={tile}
                    live={tile.kind === "record" && live.has(tile.media.mediaId)}
                    fillTarget={fillTarget}
                    onPick={onPickVisual}
                    onDrag={onDragVisual}
                    onDelete={askDelete}
                    onCancel={(v) => void cancel(v)}
                    hintId={hintId}
                  />
                ))}
              </ul>
            )}
            {sections.visual.length > 0 && (
              <p id={hintId} className={addBlock !== null && fillTarget === null ? "mine-hint mine-hint-full" : "faint mine-hint"}>
                {mineHint(fillTarget, addBlock)}
              </p>
            )}
          </section>

          <section className="mine-section" aria-label="Музыка">
            <span className="lbl">
              Музыка <span className="mono">· {sections.counts.tracks}</span>
            </span>
            {sections.tracks.length === 0 ? (
              <p className="faint mine-none">Своей музыки пока нет.</p>
            ) : (
              <ul className="mine-tracks" aria-label="Свои треки">
                {sections.tracks.map((row) => (
                  <TrackRowView
                    key={row.kind === "import" ? row.view.jobId : row.media.mediaId}
                    row={row}
                    montageMs={montageMs}
                    listening={listening}
                    onListen={(mediaId) => setListening((now) => nextListening(now, mediaId))}
                    onPick={onPickTrack}
                    onDelete={askDelete}
                    onCancel={(v) => void cancel(v)}
                    onFlagError={setFlagError}
                  />
                ))}
              </ul>
            )}
            {sections.tracks.some((row) => row.kind !== "import") && (
              <p className="faint mine-hint mine-ap-hint">«для автопилота» — автопилот может брать трек в свои видео. В этот монтаж трек ставится как раньше — кликом по строке.</p>
            )}
            {flagError !== null && <MineAlert title="Не удалось отметить трек" body={errorText(flagError)} onClose={() => setFlagError(null)} />}
          </section>

          <section className="mine-section" aria-label="Стикеры">
            <span className="lbl">
              Стикеры <span className="mono">· {sections.counts.stickers}</span>
            </span>
            {stickerWhy !== null && sections.stickers.length > 0 && (
              <p className="ed-gif-cap" role="status">
                <Icon name="alert" size={14} />
                {stickerWhy}
              </p>
            )}
            {sections.stickers.length === 0 ? (
              <p className="faint mine-none">Своих стикеров пока нет: подойдут GIF и APNG с анимацией.</p>
            ) : (
              <ul className={stickerWhy !== null ? "ed-gif-grid mine-stks ed-gif-grid-off" : "ed-gif-grid mine-stks"} aria-label="Свои стикеры">
                {sections.stickers.map((tile) => (
                  <StickerTileView
                    key={tile.kind === "import" ? tile.view.jobId : tile.media.mediaId}
                    tile={tile}
                    blocked={stickerWhy !== null}
                    why={stickerWhy}
                    onPick={onPickSticker}
                    onDelete={askDelete}
                    onCancel={(v) => void cancel(v)}
                  />
                ))}
              </ul>
            )}
          </section>

          {library.total > library.media.length && (
            <p className="faint mine-hint">
              Показаны {library.media.length} новых из {library.total}.
            </p>
          )}
        </div>
      )}
      {/* One element, one track at a time (M9). */}
      <audio ref={audio} preload="none" onEnded={() => setListening(null)} hidden />
    </div>
  );
}

/** The import that runs now, as the components sheet draws it under the drop zone (M14). */
function MineStatus({ view, queued, onCancel }: { view: ImportView; queued: number; onCancel: (view: ImportView) => void }) {
  const card = importCard(view, queued);
  return (
    <div className="drop drop-status" role="status" aria-live="polite">
      <span className="spin drop-spin" aria-hidden="true" />
      <span className="drop-text drop-status-text">
        <span className="drop-title">{card.title}</span>
        <span className="bar" role="progressbar" aria-label={card.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={card.percent}>
          <span style={{ width: `${card.percent}%` }} />
        </span>
        <span className="faint drop-sub">{card.detail}</span>
      </span>
      {!view.cancelRequested && (
        <button type="button" className="mine-x mine-x-card" aria-label={`Отменить добавление ${view.name}`} onClick={() => onCancel(view)}>
          <Icon name="close" size={12} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}

/** A refusal or a failure (M15), in the components sheet's red drop-zone state, closed by the owner. */
function MineAlert({ title, body, onClose }: { title: string; body: string | readonly string[]; onClose: () => void }) {
  const lines = typeof body === "string" ? [body] : body;
  return (
    <div className="drop drop-alert" role="alert">
      <Icon name="alert" size={18} />
      <span className="drop-text">
        <span className="drop-title">{title}</span>
        {lines.map((line, i) => (
          // Two refused files may share a name and a reason (round 1, L6): the line's place keys it, never its text.
          <span key={i} className="drop-alert-line">
            {line}
          </span>
        ))}
      </span>
      <button type="button" className="mine-x mine-x-card" aria-label={`Закрыть: ${title}`} onClick={onClose}>
        <Icon name="close" size={12} strokeWidth={2.4} />
      </button>
    </div>
  );
}
