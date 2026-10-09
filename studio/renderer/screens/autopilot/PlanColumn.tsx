import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import type { EngineError, LaunchPreview, LaunchView } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { ErrorNotice, Notice } from "../../ui/Notice";
import { useMounted } from "../photos/shared";
import { useOverflows } from "./layout";
import {
  canStop,
  ceilingUsd,
  clockLabel,
  diskLine,
  launchLine,
  launchPlanBits,
  launchTitle,
  monthMeter,
  priceSourceLabel,
  planTiles,
  stoppingLine,
  type NoteLink,
  type NoteText,
  type PlanNote,
} from "./planModel";
import { StopDialog } from "./StopDialog";
import type { PriceChange } from "./useLaunchPlan";

// S4.9a: column 3 of «Автопилот» (AutopilotS4.dc.html): the plan card with its tiles, the month's bar, the notes over «Запустить» and the button itself;
// while a launch runs, the plan folded to «План запуска» (the design's decision 3; not drawn at 1200, where «Потрачено … из $W′» says the limit) and the
// launch's own row with «Стоп». The live card with «Пауза», the avatars' progress and the log is S4.9b: this row is where it goes.

export interface GoButtonState {
  readonly title: string;
  readonly enabled: boolean;
  readonly busy: boolean;
  /** «Повторить оценку»: the plan could not be asked; the button asks again (free), it does not start anything. */
  readonly retry: boolean;
  readonly why: string | null;
}

export interface PlanCardProps {
  /** The plan the card shows (the current form's, or the last one while the next is asked). */
  readonly preview: LaunchPreview | null;
  readonly videosPerAvatar: number;
  readonly notes: readonly PlanNote[];
  readonly priceChanged: PriceChange | null;
  readonly estimateError: EngineError | null;
  readonly startError: EngineError | null;
  readonly go: GoButtonState;
  readonly goRef: RefObject<HTMLButtonElement | null>;
  readonly onGo: () => void;
}

export function PlanCard({ preview, videosPerAvatar, notes, priceChanged, estimateError, startError, go, goRef, onGo }: PlanCardProps) {
  const ids = useId();
  const tiles = planTiles(preview, videosPerAvatar);
  const meter = monthMeter(preview);
  const source = priceSourceLabel(preview);
  const disk = preview === null ? null : diskLine(preview.disk);
  const whyId = `${ids}-why`;
  return (
    <section className="card ap-plan" aria-labelledby={`${ids}-title`} aria-busy={go.busy || undefined}>
      <div className="ap-plan-head">
        <h2 id={`${ids}-title`} className="ap-h2">
          План
        </h2>
        <span className={source.fallback ? "warn-text ap-plan-source" : "faint ap-plan-source"}>{source.text}</span>
      </div>
      <div className="ap-tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className="tile ap-tile">
            <span className="muted ap-tile-label">{tile.label}</span>
            <span className={`mono ap-tile-value ap-tone-${tile.tone}`}>{tile.value}</span>
          </div>
        ))}
      </div>
      {meter !== null && (
        <div className="ap-month">
          <div className="ap-month-head">
            <span className="muted">В месяце свободно</span>
            <span className={meter.fit === "short" ? "mono ap-month-free ap-tone-danger" : "mono ap-month-free"}>
              {meter.free} <span className="faint">из {meter.budget} · UTC</span>
            </span>
          </div>
          <div className={meter.fit === "short" ? "ap-meter ap-meter-short" : "ap-meter"} role="img" aria-label={meter.label}>
            <span className="ap-meter-used" style={{ left: 0, width: `${meter.usedPct}%` }} />
            <span className="ap-meter-expected" style={{ left: `${meter.usedPct}%`, width: `${meter.expectedPct}%` }} />
            <span className="ap-meter-worst" style={{ left: `${meter.worstLeftPct}%`, width: `${meter.worstPct}%` }} />
            {meter.over && <span className="ap-meter-over" />}
          </div>
          <div className="mono faint ap-month-legend" aria-hidden="true">
            <span>
              <span className="ap-key ap-meter-used" />
              занято {meter.used}
            </span>
            <span>
              <span className="ap-key ap-meter-expected" />≈ {meter.expected}
            </span>
            <span>
              <span className="ap-key ap-meter-worst" />
              до {meter.worst}
            </span>
          </div>
        </div>
      )}
      {notes.map((note) => (
        <PlanNoteView key={note.id} note={note} />
      ))}
      {priceChanged !== null && (
        <Notice tone="warn" title="Цена выросла">
          Было не больше {ceilingUsd(priceChanged.from)}, теперь {ceilingUsd(priceChanged.to)}.
        </Notice>
      )}
      {estimateError !== null && <ErrorNotice error={estimateError} />}
      {startError !== null && <ErrorNotice error={startError} />}
      <button
        ref={goRef}
        type="button"
        className={go.retry ? "btn ap-go" : "btn btn-p ap-go"}
        aria-disabled={go.enabled ? undefined : true}
        aria-busy={go.busy || undefined}
        aria-describedby={go.why !== null && !go.busy ? whyId : undefined}
        onClick={go.enabled ? onGo : undefined}
      >
        {go.busy ? <span className="spin ap-go-spin" aria-hidden="true" /> : <Icon name="bolt" size={16} />}
        {go.title}
      </button>
      {go.why !== null && (
        <p id={whyId} className="faint ap-go-why">
          {go.why}
        </p>
      )}
      {disk !== null && <p className={disk.short ? "mono ap-disk warn-text" : "mono faint ap-disk"}>{disk.text}</p>}
    </section>
  );
}

function NoteSentence({ text }: { text: NoteText }) {
  return (
    <>
      {text.before}
      {text.link !== null && <NoteLinkButton link={text.link} />}
      {text.after}
    </>
  );
}

function NoteLinkButton({ link }: { link: NoteLink }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="link-btn"
      onClick={() => navigate(link.kind === "settings" ? { name: "settings", focus: link.focus } : { name: "photos", avatarId: link.avatarId })}
    >
      {link.label}
    </button>
  );
}

function PlanNoteView({ note }: { note: PlanNote }) {
  const body: ReactNode = (
    <>
      {note.text !== null && <NoteSentence text={note.text} />}
      {note.items.length > 0 && (
        <ul className="reason-list">
          {note.items.map((item, i) => (
            <li key={`${item.name ?? ""}-${i}`}>
              {item.name !== null && <b className="ap-note-name">{item.name}</b>}
              <NoteSentence text={item} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
  // A blocker or a short month is said at once; advice (the budget «без повторов», the balance, music, a busy avatar) politely.
  return (
    <div className="ap-note-wrap" data-note={note.id}>
      <Notice tone={note.tone} title={note.title ?? undefined} role={note.tone === "danger" ? "alert" : "status"}>
        {body}
      </Notice>
    </div>
  );
}

/** «План запуска», folded (1440 only): the numbers the click accepted. */
export function PlanMini({ launch }: { launch: LaunchView }) {
  const ids = useId();
  return (
    <section className="card ap-mini" aria-labelledby={`${ids}-title`}>
      <div className="ap-mini-head">
        <h2 id={`${ids}-title`} className="ap-h3">
          План запуска
        </h2>
        <span className="faint ap-mini-at">принят в {clockLabel(launch.createdAt)}</span>
      </div>
      <div className="mono muted ap-mini-bits">
        {launchPlanBits(launch).map((bit) => (
          <span key={bit}>{bit}</span>
        ))}
      </div>
    </section>
  );
}

/**
 * The launch's row: its state, since when, how far it got and what it spent of W′, and «Стоп» (the design's decision 9: it asks first). The heading takes the
 * focus once «Запустить» is accepted and once «Остановить» is clicked (the design's keyboard table); «Останавливаем…» stays until the engine's view says the
 * launch stopped. S4.9b grows the row into the live card («Пауза», the avatars' progress, the log, the holds).
 */
export function LaunchRow({ launch, titleRef }: { launch: LaunchView; titleRef: RefObject<HTMLHeadingElement | null> }) {
  const ids = useId();
  const { client } = useEngine();
  const mounted = useMounted();
  const stopRef = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  /** The launch this window asked to stop: «Останавливаем…» until the view says it stopped (or the ask was refused). */
  const [stopSent, setStopSent] = useState<string | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const stoppable = canStop(launch);
  const stopping = launch.status === "stopping" || (stopSent === launch.launchId && stoppable);
  const status = stopping ? "stopping" : launch.status;
  const ended = status === "done" || status === "stopped";
  const busy = status === "pausing" || status === "stopping";
  const tone = status === "done" ? "ap-live-done" : status === "paused" || busy ? "ap-live-paused" : status === "stopped" ? "ap-live-stopped" : "";

  const stop = async (): Promise<void> => {
    setAsking(false);
    setError(null);
    setStopSent(launch.launchId);
    const reply = await client.request("autopilot.stop", { launchId: launch.launchId });
    if (!mounted.current || reply.ok) return;
    setStopSent(null);
    setError(reply.error);
  };

  return (
    <section id="ap-live" className={`card ap-live ${tone}`} aria-labelledby={`${ids}-title`}>
      <div className="ap-live-head">
        <h2 id={`${ids}-title`} ref={titleRef} className="ap-h2 ap-live-title" tabIndex={-1} aria-live="polite">
          {busy && <span className="spin ap-live-spin" aria-hidden="true" />}
          {launchTitle(status)}
        </h2>
        <span className="mono muted">{ended && launch.endedAt !== null ? `${clockLabel(launch.createdAt)}–${clockLabel(launch.endedAt)}` : `с ${clockLabel(launch.createdAt)}`}</span>
        {(stoppable || stopping) && (
          <div className="ap-live-actions">
            <button
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
      </div>
      {stopping && <p className="ap-live-sub">{stoppingLine(launch)}</p>}
      <p className="mono muted ap-live-line">{launchLine(launch)}</p>
      {error !== null && <ErrorNotice error={error} />}
      {asking && (
        <StopDialog
          launch={launch}
          onCancel={() => setAsking(false)}
          onStop={() => void stop()}
          returnFocus={(stopped) => (stopped ? titleRef.current : stopRef.current)}
        />
      )}
    </section>
  );
}

/** Column 3 as a scrolling area with the design's fade at its foot (only when its content is longer than it is). */
export function PlanColumn({ children }: { children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const over = useOverflows(scroller, content);
  return (
    <div className="ap-fw ap-col3">
      <div ref={scroller} className="ap-sc">
        <div ref={content} className="ap-sc-in ap-col3-in">
          {children}
        </div>
      </div>
      {over && <div className="ap-fd ap-fd-page" aria-hidden="true" />}
    </div>
  );
}
