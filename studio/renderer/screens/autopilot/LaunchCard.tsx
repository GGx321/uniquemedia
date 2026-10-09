import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { EngineError, LaunchStatus, LaunchView } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { useMounted } from "../photos/shared";
import { useOverflows } from "./layout";
import {
  askedView,
  avatarLine,
  endedLine,
  headerMeta,
  headerSub,
  liveNote,
  logRows,
  resumePlace,
  resumeTitle,
  resumeWhy,
  shownStatus,
  spentBlock,
  type AvatarLine,
  type LiveNote,
  type NoteAction,
} from "./liveModel";
import { ceilingUsd, launchTitle, videosOf } from "./planModel";
import { StopDialog } from "./StopDialog";

// S4.9b: the live launch card (AutopilotS4.dc.html, states review-wait … paused-reviewed; LaunchStates; README decisions 6–9 and round 1 M6). Its header —
// the status, since when, the buttons — and the one notice of a hold or a reason are pinned; «Потрачено», the avatars' rows and the log scroll under them,
// with the fade only while they overflow. «Пауза» asks nothing, «Стоп» asks first, «Продолжить · до $R» carries its sum. Every figure is the view's.

/**
 * The mono line beside the title. While the launch runs it ticks («в работе 2:41»): the view's figure plus the time since it came, in a component of its own
 * so the second's tick redraws this line only (round 1 L11).
 */
function LiveMeta({ launch, status }: { launch: LaunchView; status: LaunchStatus }) {
  const ticking = status === "running";
  const [arrived, setArrived] = useState(() => ({ view: launch, at: Date.now() }));
  const [now, setNow] = useState(() => Date.now());
  if (arrived.view !== launch) {
    const at = Date.now();
    setArrived({ view: launch, at });
    setNow(at);
  }
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const meta = headerMeta(launch, status, ticking ? launch.activeMs + Math.max(0, now - arrived.at) : launch.activeMs);
  return meta === null ? null : <span className="mono muted ap-live-meta">{meta}</span>;
}

/**
 * The engine's word on the launch asked for directly (`autopilot.get`): after PRICE_CHANGED on «Продолжить», and after a money or settings change while
 * «Продолжить» is closed (H1: the engine sends no `autopilot.changed` for those yet). It stands for `base` — the view it was asked over — until the engine's
 * next `autopilot.changed`, and the whole card shows it, so one R is said everywhere (round 1 L10). `recountFrom`: the R the refused click had accepted.
 */
interface Asked {
  readonly base: LaunchView;
  readonly view: LaunchView;
  readonly recountFrom: number | null;
}

export interface LaunchCardProps {
  readonly launch: LaunchView;
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
  readonly wide: boolean;
  readonly nameOf: (avatarId: string) => string;
  /** S4.9c: «Мои треки…» of the waiting-music notice opens the music chip's window. */
  readonly onMusic?: () => void;
  /**
   * S4.6g: the finished videos of this launch whose records stand, as the history counts them (`LaunchSummary.videosDone`). The view's own count is of what the launch
   * made, a video the owner deleted since included; once the history has answered, «Результаты · N» is this one.
   */
  readonly resultsDone?: number | undefined;
}

export function LaunchCard({ launch: engineLaunch, titleRef, wide, nameOf, onMusic, resultsDone }: LaunchCardProps) {
  const ids = useId();
  const { client } = useEngine();
  const { money, settings } = useEngineView();
  const navigate = useNavigate();
  const mounted = useMounted();
  const resumeRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);

  const [asking, setAsking] = useState(false);
  /** The launch this window asked to pause / to stop: «Ставим на паузу…» / «Останавливаем…» until the view says so (or the ask was refused). */
  const [pauseSent, setPauseSent] = useState<string | null>(null);
  const [stopSent, setStopSent] = useState<string | null>(null);
  /**
   * A paid click (round 1 M4): `pending` while its command is on its way; once accepted, `over` is the engine's view it was sent over, and the button stays
   * busy until another view comes — the one that says what the click did. Like `pauseSent`, never two sends for one click.
   */
  const [resumeSent, setResumeSent] = useState<{ pending: boolean; over: LaunchView } | null>(null);
  const [continueSent, setContinueSent] = useState<{ avatarId: string; pending: boolean; over: LaunchView } | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [asked, setAsked] = useState<Asked | null>(null);
  /** Where the focus goes once the screen shows what a click did (an effect: the element may only just be mounted). */
  const [focusNext, setFocusNext] = useState<"resume" | "title" | null>(null);
  /** A paid click in flight: a second click before React re-renders never sends twice. */
  const sending = useRef(false);

  const current = asked !== null && asked.base === engineLaunch ? asked : null;
  const launch: LaunchView = current === null ? engineLaunch : askedView(engineLaunch, current.view);
  const status = shownStatus(launch, { pause: pauseSent === launch.launchId, stop: stopSent === launch.launchId });
  const ended = status === "done" || status === "stopped";
  const note = liveNote(launch, status, nameOf);
  const place = resumePlace(launch, status, note);
  const remaining = launch.remainingMicros;
  const blocked = launch.resumeBlockedBy;
  const resuming = resumeSent !== null && (resumeSent.pending || resumeSent.over === engineLaunch);
  const continuing = continueSent !== null && (continueSent.pending || continueSent.over === engineLaunch) ? continueSent.avatarId : null;
  const resumeOpen = blocked === null && !resuming;
  const whyId = `${ids}-why`;
  const noteTextId = `${ids}-note`;
  // Closed, the button is described by its reason: the notice's «why» line, else the notice itself, else the line under the header.
  const resumeDescribedBy = blocked === null ? undefined : note !== null && note.why === null ? noteTextId : whyId;

  // The pause landed: the focus goes from «Пауза» to «Продолжить · до $R» (the design's keyboard table).
  useEffect(() => {
    if (pauseSent === null) return;
    if (pauseSent !== launch.launchId || launch.status === "paused" || launch.status === "stopped" || launch.status === "done") {
      if (pauseSent === launch.launchId && launch.status === "paused") setFocusNext("resume");
      setPauseSent(null);
    }
  }, [pauseSent, launch.launchId, launch.status]);
  useEffect(() => {
    if (stopSent !== null && (stopSent !== launch.launchId || launch.status === "stopped" || launch.status === "done")) setStopSent(null);
  }, [stopSent, launch.launchId, launch.status]);
  // «Продолжить» accepted and the view says so: the focus goes to the heading («Идёт запуск»), and the button may be clicked again.
  useEffect(() => {
    if (resumeSent === null || resumeSent.pending || resumeSent.over === engineLaunch) return;
    setResumeSent(null);
    setFocusNext("title");
  }, [resumeSent, engineLaunch]);
  useEffect(() => {
    if (continueSent !== null && !continueSent.pending && continueSent.over !== engineLaunch) setContinueSent(null);
  }, [continueSent, engineLaunch]);
  useEffect(() => {
    if (focusNext === null) return;
    if (focusNext === "resume") resumeRef.current?.focus();
    else titleRef.current?.focus();
    setFocusNext(null);
  }, [focusNext, titleRef]);

  // H1 (interim, until the engine sends `autopilot.changed` on these): while «Продолжить» is closed, a change of the money (a reconcile, a halt lifted), the
  // key or the budget may open it — the card asks the engine for its word on the launch.
  // Asked only while the button is closed: once as the card opens — the fix may have been made elsewhere meanwhile («Перейти к сверке» leaves the screen, and
  // the engine's view kept since is the one from before the reconcile) — and again on every change of the money or the settings while the card is open. The
  // answer stands for the view it was asked over only (`asked.base`): the engine's next `autopilot.changed` replaces it.
  const latest = useRef({ launch: engineLaunch, closed: blocked !== null && !ended });
  useLayoutEffect(() => {
    latest.current = { launch: engineLaunch, closed: blocked !== null && !ended };
  });
  const askEngine = useRef<() => () => void>(() => () => undefined);
  askEngine.current = () => {
    const { launch: over, closed } = latest.current;
    if (!closed) return () => undefined;
    let alive = true;
    void client.request("autopilot.get", { launchId: over.launchId }).then((reply) => {
      if (alive && mounted.current && reply.ok) setAsked((now) => ({ base: over, view: reply.result.launch, recountFrom: now !== null && now.base === over ? now.recountFrom : null }));
    });
    return () => {
      alive = false;
    };
  };
  useEffect(() => askEngine.current(), []);
  const seen = useRef({ money, settings });
  useEffect(() => {
    if (seen.current.money === money && seen.current.settings === settings) return;
    seen.current = { money, settings };
    return askEngine.current();
  }, [money, settings]);

  const pause = async (): Promise<void> => {
    setError(null);
    setPauseSent(launch.launchId);
    const reply = await client.request("autopilot.pause", { launchId: launch.launchId });
    if (!mounted.current || reply.ok) return;
    setPauseSent(null);
    setError(reply.error);
  };

  const stop = async (): Promise<void> => {
    setAsking(false);
    setError(null);
    setStopSent(launch.launchId);
    const reply = await client.request("autopilot.stop", { launchId: launch.launchId });
    if (!mounted.current || reply.ok) return;
    setStopSent(null);
    setError(reply.error);
  };

  const resume = async (): Promise<void> => {
    if (sending.current || blocked !== null || resuming) return;
    sending.current = true;
    const accepted = remaining;
    const over = engineLaunch;
    setResumeSent({ pending: true, over });
    setError(null);
    try {
      const reply = await client.request("autopilot.resume", { launchId: launch.launchId, acceptedRemainingMicros: accepted });
      if (!mounted.current) return;
      if (reply.ok) {
        setAsked(null);
        // Busy until the engine's next word on the launch: the one that says it runs again.
        setResumeSent({ pending: false, over });
        return;
      }
      setResumeSent(null);
      if (reply.error.code !== "PRICE_CHANGED") {
        setError(reply.error);
        return;
      }
      // R moved under the screen: the engine's own word, asked again; the whole card shows its R, the focus stays on the button with the new sum (LaunchStates
      // «Остаток пересчитан»), and only a new click sends it.
      const fresh = await client.request("autopilot.get", { launchId: launch.launchId });
      if (!mounted.current) return;
      if (fresh.ok) setAsked({ base: over, view: fresh.result.launch, recountFrom: accepted });
      else setError(fresh.error);
    } finally {
      sending.current = false;
    }
  };

  const continueReview = async (action: Extract<NoteAction, { kind: "continue" }>): Promise<void> => {
    if (sending.current || continuing !== null) return;
    sending.current = true;
    const over = engineLaunch;
    setContinueSent({ avatarId: action.avatarId, pending: true, over });
    setError(null);
    const reply = await client.request("autopilot.continueAfterReview", { launchId: launch.launchId, avatarId: action.avatarId, sceneSetId: action.sceneSetId, revision: action.revision });
    sending.current = false;
    if (!mounted.current) return;
    if (reply.ok) {
      setContinueSent({ avatarId: action.avatarId, pending: false, over });
      return;
    }
    setContinueSent(null);
    setError(reply.error);
  };

  const act = (action: NoteAction): void => {
    switch (action.kind) {
      case "settings":
        navigate({ name: "settings", focus: action.focus });
        return;
      case "photos":
        navigate({ name: "photos", avatarId: action.avatarId, focus: "launch" });
        return;
      case "avatars":
        navigate({ name: "avatars" });
        return;
      case "continue":
        void continueReview(action);
        return;
      case "stop":
        setAsking(true);
        return;
      case "music":
        onMusic?.();
        return;
    }
  };
  /** S4.9c: the launch's own page — its results and its whole log. */
  const openLaunch = (): void => navigate({ name: "launch", launchId: launch.launchId, from: "autopilot" });

  const resumeButton = (
    <button
      key="resume"
      ref={resumeRef}
      type="button"
      className="btn btn-p btn-s ap-resume"
      aria-disabled={resumeOpen ? undefined : true}
      aria-busy={resuming || undefined}
      aria-describedby={resumeDescribedBy}
      onClick={resumeOpen ? () => void resume() : undefined}
    >
      {resuming && <span className="spin ap-btn-spin" aria-hidden="true" />}
      {resumeTitle(remaining, launch.plannedWorstMicros, launch.spentMicros)}
    </button>
  );

  const pausing = status === "pausing";
  const stopping = status === "stopping";
  const busyTitle = pausing || stopping;
  const sub = note === null ? headerSub(launch, status, nameOf) : null;
  const tone = status === "done" ? "ap-live-done" : status === "stopped" ? "ap-live-stopped" : "";
  const compact = ended && !wide;
  const recount = current !== null && current.recountFrom !== null && current.recountFrom !== current.view.remainingMicros ? { from: current.recountFrom, to: current.view.remainingMicros } : null;

  return (
    <section id="ap-live" className={`card ap-live ${ended ? "ap-live-ended" : ""} ${compact ? "ap-live-compact" : ""} ${tone}`} aria-labelledby={`${ids}-title`}>
      <div className="ap-live-pin">
        <div className="ap-live-head">
          {status === "done" && (
            <span className="ap-live-ok" aria-hidden="true">
              <Icon name="check" size={16} strokeWidth={2.4} />
            </span>
          )}
          <h2 id={`${ids}-title`} ref={titleRef} className="ap-h2 ap-live-title" tabIndex={-1} aria-live="polite">
            {busyTitle && <span className="spin ap-live-spin" aria-hidden="true" />}
            {launchTitle(status)}
          </h2>
          {!compact && <LiveMeta launch={launch} status={status} />}
          {!ended && (
            <div className="ap-live-actions">
              {(status === "running" || pausing) && (
                <button
                  key="pause"
                  type="button"
                  className="btn btn-s"
                  aria-disabled={pausing || undefined}
                  aria-busy={pausing || undefined}
                  onClick={pausing ? undefined : () => void pause()}
                >
                  Пауза
                </button>
              )}
              {place === "header" && resumeButton}
              <button
                key="stop"
                ref={stopRef}
                type="button"
                className="btn btn-s"
                aria-disabled={stopping || undefined}
                aria-busy={stopping || undefined}
                aria-haspopup="dialog"
                onClick={stopping ? undefined : () => setAsking(true)}
              >
                Стоп
              </button>
            </div>
          )}
          {ended && compact && (
            <div className="ap-live-actions">
              <button type="button" className="btn btn-p btn-xs" onClick={openLaunch}>
                Результаты · {resultsDone ?? videosOf(launch).done}
              </button>
            </div>
          )}
        </div>
        {sub !== null && !compact && <p className="ap-live-sub">{sub}</p>}
        {compact && <p className="mono muted ap-live-line">{endedLine(launch)}</p>}
        {note !== null && (
          <LiveNoteView
            key={note.id}
            note={note}
            textId={noteTextId}
            whyId={whyId}
            resume={place === "note" ? resumeButton : null}
            continuing={continuing}
            onAct={act}
          />
        )}
        {note === null && place === "header" && blocked !== null && (
          <p id={whyId} className="faint ap-live-why">
            {resumeWhy(launch, blocked)}
          </p>
        )}
        {recount !== null && (
          <Notice tone="warn" title="Остаток пересчитан" role="status">
            Пока экран был открыт, часть запросов закрылась дешевле. Было до {ceilingUsd(recount.from)}, теперь до {ceilingUsd(recount.to)} — нажмите ещё раз.
          </Notice>
        )}
        {error !== null && <ErrorNotice error={error} />}
      </div>

      {ended ? (
        !compact && (
          <>
            {status === "done" && <SpentView launch={launch} />}
            {/* S4.9c (ApDone): the launch's results and its whole log, on its own page. */}
            <div className="ap-live-ended-acts">
              <button type="button" className="btn btn-p btn-s" onClick={openLaunch}>
                Результаты · {resultsDone ?? videosOf(launch).done}
              </button>
              <button type="button" className="btn btn-s" onClick={openLaunch}>
                Журнал
              </button>
            </div>
          </>
        )
      ) : (
        <LiveBody
          launch={launch}
          nameOf={nameOf}
          wide={wide}
          onOpen={(avatarId, kind) => (kind === "avatars" ? navigate({ name: "avatars" }) : navigate({ name: "photos", avatarId, focus: "launch" }))}
          onJournal={openLaunch}
        />
      )}

      {asking && (
        <StopDialog
          launch={launch}
          nameOf={nameOf}
          onCancel={() => setAsking(false)}
          onStop={() => void stop()}
          returnFocus={(stopped) => (stopped ? titleRef.current : stopRef.current)}
        />
      )}
    </section>
  );
}

function LiveNoteView({
  note,
  textId,
  whyId,
  resume,
  continuing,
  onAct,
}: {
  note: LiveNote;
  textId: string;
  whyId: string;
  resume: ReactNode;
  continuing: string | null;
  onAct: (action: NoteAction) => void;
}) {
  const icon = note.icon === "pause" ? "pause" : note.icon === "info" ? "info" : "alert";
  // Holds and skips are said at once when they appear; scenes to review and a restart politely (the design's keyboard table: «Плашки запуска»).
  const role = note.tone === "info" ? "status" : "alert";
  const actions = note.actions;
  return (
    <div className={`notice notice-${note.tone} ap-live-note`} role={role} data-note={note.id}>
      <span className="notice-icon">
        <Icon name={icon} size={16} />
      </span>
      <div className="notice-body">
        <p className="notice-title">{note.title}</p>
        <div id={textId} className="notice-text">
          {note.text}
        </div>
        {(actions.length > 0 || resume !== null) && (
          <div className="notice-actions">
            {actions.map((action) => {
              const primary = action.kind === "continue";
              const busy = action.kind === "continue" && continuing === action.avatarId;
              return (
                <button
                  key={`${action.kind}-${action.label}`}
                  type="button"
                  className={primary ? "btn btn-p btn-s" : action.kind === "stop" ? "btn btn-s btn-d" : "btn btn-s"}
                  aria-busy={busy || undefined}
                  aria-disabled={busy || undefined}
                  onClick={busy ? undefined : () => onAct(action)}
                >
                  {busy && <span className="spin ap-btn-spin" aria-hidden="true" />}
                  {action.label}
                </button>
              );
            })}
            {resume}
          </div>
        )}
        {note.why !== null && (
          <p id={whyId} className="faint ap-live-note-why">
            {note.why}
          </p>
        )}
      </div>
    </div>
  );
}

/** The card's scrolling body (round 1 M6): «Потрачено», the rows and the log under the pinned header, with the fade only while they overflow. */
function LiveBody({
  launch,
  nameOf,
  wide,
  onOpen,
  onJournal,
}: {
  launch: LaunchView;
  nameOf: (avatarId: string) => string;
  wide: boolean;
  onOpen: (avatarId: string, kind: "photos" | "avatars") => void;
  onJournal: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const over = useOverflows(scroller, content);
  return (
    <div className="ap-fw ap-live-body">
      <div ref={scroller} className="ap-sc">
        <div ref={content} className="ap-live-in">
          <SpentView launch={launch} />
          <AvatarRows launch={launch} nameOf={nameOf} onOpen={onOpen} />
          <LogView launch={launch} nameOf={nameOf} wide={wide} onJournal={onJournal} />
        </div>
      </div>
      {over && <div className="ap-fd" aria-hidden="true" />}
    </div>
  );
}

/** «Потрачено $S из $W′» with the open reserves hatched, what they are, and «Правки сцен» apart (decision 6). */
function SpentView({ launch }: { launch: LaunchView }) {
  const block = spentBlock(launch);
  return (
    <div className="ap-spent">
      <div className="ap-spent-row">
        <span className="muted">Потрачено</span>
        <span className="mono ap-spent-value">
          {block.spent !== null && `${block.spent} `}
          <span className="faint">{block.of}</span>
        </span>
      </div>
      {block.spent !== null && (
        <div className="bar ap-spent-bar" role="img" aria-label={block.label}>
          <span className="ap-spent-settled" style={{ width: `${block.settledPct}%` }} />
          <span className="ap-hatch" style={{ width: `${block.openPct}%` }} />
        </div>
      )}
      {block.sub !== null && <span className="mono faint ap-spent-sub">{block.sub}</span>}
      {block.reviewWrites !== null && (
        <div className="ap-spent-row">
          <span className="muted">Правки сцен</span>
          <span className="mono ap-spent-value">
            {block.reviewWrites} <span className="faint">отдельно</span>
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * «Фото · Монтаж · Готово» for every avatar of the launch: its phase in words and colour, three bars, and its one action. A table of five columns (S4.9b L14):
 * the avatar (the row's header), its phase with the action, then the three bars; the first two headers are for a screen reader only, the design draws none.
 */
function AvatarRows({ launch, nameOf, onOpen }: { launch: LaunchView; nameOf: (avatarId: string) => string; onOpen: (avatarId: string, kind: "photos" | "avatars") => void }) {
  const lines: AvatarLine[] = launch.avatars.map((row) => avatarLine(launch, row, nameOf(row.avatarId)));
  return (
    <div className="ap-rows" role="table" aria-label="Ход по аватарам">
      <div className="ap-grid3 ap-rows-head" role="row">
        <span role="columnheader" className="sr-only">
          Аватар
        </span>
        <span role="columnheader" className="sr-only">
          Ход
        </span>
        <span role="columnheader" className="faint">
          Фото
        </span>
        <span role="columnheader" className="faint">
          Монтаж
        </span>
        <span role="columnheader" className="faint">
          Готово
        </span>
      </div>
      {lines.map((line) => (
        <div key={line.avatarId} className="ap-row-av" role="row" data-avatar={line.avatarId}>
          <div className="ap-row-top">
            <span role="rowheader" className="ap-row-name">
              {line.name}
            </span>
            <div role="cell" className="ap-row-state">
              <span className={`ap-row-phase ap-fg-${line.tone}`} title={line.phase}>
                {line.phase}
              </span>
              {line.action !== null && (
                <button type="button" className="btn btn-xs ap-row-act" onClick={() => onOpen(line.avatarId, line.action?.kind ?? "photos")} aria-label={`${line.action.label} · ${line.name}`}>
                  {line.action.label}
                </button>
              )}
            </div>
          </div>
          <div className="ap-grid3">
            {line.cells.map((cell, i) => (
              <div key={i} role="cell" className="ap-cell">
                <span className="mono muted ap-cell-text">{cell.text}</span>
                <div className="bar">
                  <span className={`ap-cell-${i}`} style={{ width: `${cell.pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The log's tail, newest first: time, avatar (in the line at 1200), what happened. */
function LogView({ launch, nameOf, wide, onJournal }: { launch: LaunchView; nameOf: (avatarId: string) => string; wide: boolean; onJournal: () => void }) {
  const rows = logRows(launch, nameOf);
  if (rows.length === 0) return null;
  return (
    <div className="ap-log-block">
      <div className="ap-log-head">
        <span className="faint ap-log-title">Журнал</span>
        {/* S4.9c: the card holds the last 20 lines; the launch's page holds the whole log. */}
        <button type="button" className="link-btn ap-log-all" onClick={onJournal}>
          Весь журнал
        </button>
      </div>
      <ol aria-label="Журнал" className={wide ? "mono ap-log" : "mono ap-log ap-log-n"}>
        {rows.map((row) => (
          <li key={row.key} className={`ap-log-${row.tone}`}>
            <span className="faint">{row.at}</span>
            {wide ? <span className="ap-log-who" title={row.who}>{row.who}</span> : null}
            <span>{wide || row.who === "—" ? row.text : `${row.who} · ${row.text}`}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
