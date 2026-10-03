import { useCallback, useEffect, useId, useState } from "react";
import type { EngineError, MontageDraft, MusicStatus, TrackSummary } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { useEngine } from "../../engine/react";
import { errorText } from "../../lib/errors";
import { placeholderGradient, trackCoverUrl } from "../../lib/media";
import { dayTimeLabel, quotaView } from "../../lib/music";
import { useNavigate } from "../../navigation";
import { Icon } from "../../ui/Icon";
import { totalMs } from "./clipOps";
import { secondsLabel, trackClock, trackTitle } from "./labels";
import { type TrackRow, trackRows } from "./musicOps";

// 3d.5: the «Музыка» tab (EditorMusic.dc.html; U1–U18, the components sheet's track rows). The stored trending tracks, in the list's
// own order, with the «E» badge on explicit ones (still pickable) and no "trending only" filter (`is_trending_in_clips` is always
// false). A click puts the track into the montage at its first highlight that fits (musicOps `pickTrack`). Everything here is free:
// `music.list` and `music.status` read what is on disk. The paid «Обновить» (1 of 30 requests per 31 days) lives in Settings only,
// behind its confirmation (3c.6): the tab shows the quota and links there, it never sends `music.refresh` itself.

export type TrackList = { readonly state: "loading" } | { readonly state: "ready"; readonly tracks: readonly TrackSummary[] } | { readonly state: "failed"; readonly error: EngineError };

/** The stored tracks (`music.list`), read again whenever the list was fetched anew; the last answer stays while a new one is out. */
export function useTrackList(client: EngineClient, listVersion: string | null): { list: TrackList; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<TrackList>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    void client.request("music.list", {}).then((reply) => {
      if (alive) setList(reply.ok ? { state: "ready", tracks: reply.result.tracks } : { state: "failed", error: reply.error });
    });
    return () => {
      alive = false;
    };
  }, [client, listVersion, attempt]);
  const retry = useCallback(() => {
    setList({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { list, retry };
}

/** «2:55»: a track's length in whole seconds, as the list shows it. */
export function trackLength(ms: number): string {
  return trackClock(Math.floor(ms / 1000) * 1000);
}

/** A cover: the stored picture, else a placeholder of its own colour. */
export function Cover({ track, className }: { track: Pick<TrackSummary, "trackId" | "hasCover">; className: string }) {
  const { client } = useEngine();
  const url = trackCoverUrl(client, track);
  return (
    <span className={className} style={{ background: placeholderGradient(track.trackId) }} aria-hidden="true">
      {url !== null && <img src={url} alt="" draggable={false} />}
    </span>
  );
}

/** What the row says on its right, under the length: «✓ в ролике», «короче ролика», «★ 1:02». */
function rowNote(row: TrackRow): string | null {
  if (row.inDraft) return "✓ в ролике";
  if (row.tooShort) return "короче ролика";
  return row.star === null ? null : `★ ${trackClock(row.star)}`;
}

function rowName(row: TrackRow, totalMs: number): string {
  const { track } = row;
  const parts = [trackTitle(track), ...(track.explicit ? ["пометка E (explicit)"] : []), trackLength(track.durationMs)];
  if (row.inDraft) parts.push("в ролике");
  else if (row.tooShort) parts.push(`короче ролика (${secondsLabel(totalMs)}), не выбрать`);
  else if (row.star !== null) parts.push(`лучшая часть с ${trackClock(row.star)}`);
  return parts.join(", ");
}

export interface MusicTabProps {
  readonly spec: MontageDraft;
  /** The list and quota status (`music.status`, free); null until it is known. */
  readonly status: MusicStatus | null;
  /** A track the owner picked (never one shorter than the montage). */
  readonly onPick: (track: TrackSummary) => void;
}

export function MusicTab({ spec, status, onPick }: MusicTabProps) {
  const { client, store } = useEngine();
  const navigate = useNavigate();
  const quotaId = useId();
  const [hideExplicit, setHideExplicit] = useState(false);
  // Free: it reads the quota log and the list on disk (and writes a line the log still holds), never a request to flashapi.
  useEffect(() => {
    void store.refreshMusic();
  }, [store]);
  const { list, retry } = useTrackList(client, status?.listFetchedAt ?? null);
  const total = totalMs(spec);
  const tracks = list.state === "ready" ? list.tracks : [];
  const rows = trackRows(tracks, spec.music, total, { hideExplicit });
  const anyExplicit = tracks.some((t) => t.explicit);
  const toSettings = (): void => navigate({ name: "settings", focus: "music" });
  const quota = status === null ? null : quotaView(status);

  return (
    <>
      <div className="ed-music-head">
        <div className="ed-prow">
          <span className="fl">В тренде Instagram</span>
          {anyExplicit && (
            <button type="button" className={hideExplicit ? "chip chip-on ed-chip-s" : "chip ed-chip-s"} aria-pressed={hideExplicit} aria-label="Скрыть треки с пометкой E" onClick={() => setHideExplicit((on) => !on)}>
              Скрыть <span className="e" aria-hidden="true">E</span>
            </button>
          )}
        </div>
        <span className="mono faint ed-music-age">{status === null ? " " : status.listFetchedAt === null ? "список ещё не загружался" : `обновлено ${dayTimeLabel(Date.parse(status.listFetchedAt))}`}</span>
      </div>

      {list.state === "loading" ? (
        <div className="ed-tracks" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="trow ed-track-shim">
              <span className="cov ph">
                <span className="shim" />
              </span>
            </div>
          ))}
        </div>
      ) : list.state === "failed" ? (
        <div className="ed-music-empty" role="alert">
          <p className="muted">Не удалось прочитать список треков. {errorText(list.error)}</p>
          <button type="button" className="btn btn-s" onClick={retry}>
            Повторить
          </button>
        </div>
      ) : tracks.length === 0 ? (
        <div className="ed-music-empty">
          <p className="muted">{status?.listFetchedAt === null ? "Список трендов ещё не загружен." : "В списке трендов пока нет треков."} Его загружают в Настройках: каждый раз это 1 запрос из 30.</p>
        </div>
      ) : (
        <ul className="ed-tracks" aria-label="Треки в тренде">
          {rows.map((row) => {
            const note = rowNote(row);
            const classes = ["trow", row.inDraft ? "trow-on" : "", row.tooShort ? "trow-off" : ""].filter(Boolean).join(" ");
            return (
              <li key={row.track.trackId}>
                <button
                  type="button"
                  className={classes}
                  aria-label={rowName(row, total)}
                  aria-current={row.inDraft ? "true" : undefined}
                  aria-disabled={row.tooShort ? "true" : undefined}
                  title={row.tooShort ? `Трек короче ролика (${secondsLabel(total)}) — его не выбрать` : row.inDraft ? "Этот трек уже в ролике" : "Клик — трек в ролик"}
                  onClick={() => {
                    if (!row.tooShort) onPick(row.track);
                  }}
                >
                  <Cover track={row.track} className="cov" />
                  <span className="trow-body">
                    <span className="trow-title">
                      <span className="trow-name">{row.track.title}</span>
                      {row.track.explicit && (
                        <span className="e" aria-hidden="true">
                          E
                        </span>
                      )}
                    </span>
                    <span className="muted trow-artist">{row.track.artist ?? "исполнитель не указан"}</span>
                  </span>
                  <span className="trow-end">
                    <span className="mono faint">{trackLength(row.track.durationMs)}</span>
                    {note !== null && <span className={row.inDraft ? "mono trow-note trow-note-on" : "mono trow-note"}>{note}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="ed-music-foot">
        {quota !== null && (
          <>
            <span id={quotaId} className="muted ed-music-quota">
              {quota.figure.sent} из {quota.figure.limit} запросов за 31 день
            </span>
            <div className={`bar bar-${quota.tone}`} role="progressbar" aria-labelledby={quotaId} aria-valuemin={0} aria-valuemax={quota.figure.limit} aria-valuenow={quota.figure.sent} aria-valuetext={quota.line}>
              <span style={{ width: `${quota.share}%` }} />
            </div>
          </>
        )}
        <button type="button" className="btn btn-s ed-music-settings" onClick={toSettings}>
          <Icon name="reload" size={14} />
          Обновить список — в Настройках
        </button>
        <span className="faint ed-music-note">Список обновляется только вручную, в Настройках: 1 запрос из 30, с подтверждением. Выбор трека здесь бесплатный.</span>
      </div>
    </>
  );
}
