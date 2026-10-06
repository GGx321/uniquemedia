import { useEffect, useState, type ReactNode } from "react";
import type { CategoryPool, EngineError, Estimate } from "../../../shared/engine";
import type { CategoryLibraryView } from "../../engine/categoryLibrary";
import type { EngineView } from "../../engine/store";
import { formatUsdTiered } from "../../lib/money";
import { Icon } from "../../ui/Icon";
import { placeRemoval, shotShares, timeLabel } from "./categoryText";
import { modelName } from "./runForm";

// CS.3: the pieces the create dialog and the «Мои категории» sheet share: the pool call's price as a button may show it, the seconds a
// call has run, and the pool as the artboards draw it (places with their Russian times and their activities, outfits, the shot deck).

/** The pool call makes at most this many answered attempts (the engine's POOL_MAX_ATTEMPTS, scenes/poolCall.ts): its worst case is two. */
const POOL_ATTEMPTS = 2;

/**
 * The pool call's price as a paid button may offer it: only the one for the text model the call runs on now (the slice keys it so); a
 * price for another model is never shown, and none means «до …» on a disabled button.
 */
export function categoryPrice(engine: EngineView, slice: CategoryLibraryView): { estimate: Estimate | null; error: EngineError | null } {
  const key = engine.settings?.textModel ?? null;
  const estimate = slice.price !== null && slice.price.key === key ? slice.price.estimate : null;
  return { estimate, error: estimate === null ? slice.priceError : null };
}

/** «≈ $0.006 · до $0.045», the design's money rule. */
export function priceRange(estimate: Estimate): string {
  return `≈ ${formatUsdTiered(estimate.expectedMicros, "nearest")} · до ${formatUsdTiered(estimate.worstMicros, "up")}`;
}

/** «до $0.045» on a paid button: the worst case it sends as `acceptedWorstMicros`. */
export function worstOf(estimate: Estimate | null): string {
  return estimate === null ? "до …" : `до ${formatUsdTiered(estimate.worstMicros, "up")}`;
}

const PRICE_DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** «grok-4.3 · не больше 2 попыток · цены OpenRouter · 5 окт.»: what the price is for, and where it came from. */
export function priceSource(estimate: Estimate, textModel: string): string {
  const day = PRICE_DAY.format(Date.parse(`${estimate.pricesAsOf}T00:00:00Z`));
  return `${modelName(textModel)} · не больше ${POOL_ATTEMPTS} попыток · ${estimate.prices === "live" ? "цены OpenRouter" : "резервные цены"} · ${day}`;
}

/** Whole seconds since `since` (`Date.now()` at the click), counted on while it is set: «Составляем … · 12 с». */
export function useSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** The shot deck as the artboards draw it: a bar of shares and its legend with percentages. */
export function ShotShares({ pool, note }: { pool: CategoryPool; note?: ReactNode }) {
  const shares = shotShares(pool.shotDeck);
  return (
    <div className="cat-block">
      <span className="lbl">Кадры</span>
      <div className="cat-shot-bar" aria-hidden="true">
        {shares.map((s) => (
          <span key={s.shot} className={`shot-${s.shot}`} style={{ width: `${s.percent}%` }} />
        ))}
      </div>
      <ul className="cat-shot-legend">
        {shares.map((s) => (
          <li key={s.shot}>
            <span className={`photos-shot-dot shot-${s.shot}`} aria-hidden="true" />
            {s.label}
            <span className="mono muted">{s.percent}%</span>
          </li>
        ))}
      </ul>
      {note}
    </div>
  );
}

/** One place: its English name as it goes into the prompts, the mirror mark, its times in Russian, and what she does there. */
function PlaceRow({ place, aside }: { place: CategoryPool["locations"][number]; aside?: ReactNode }) {
  return (
    <>
      <span className="cat-place-name">
        <span lang="en" className="cat-place-text">
          {place.name}
        </span>
        {place.mirror && <span className="mono cat-mirror">зеркало</span>}
      </span>
      <span className="cat-times">
        {place.times.map((t) => (
          <span key={t} className="tag tag-o cat-time">
            {timeLabel(t)}
          </span>
        ))}
      </span>
      {aside}
      <span lang="en" className="faint cat-acts">
        {place.activities.map((a) => a.text).join(" · ")}
      </span>
    </>
  );
}

/** The pool as the create dialog shows it once made: read-only (places and outfits are removed in «Мои категории»). */
export function PoolPreview({ pool }: { pool: CategoryPool }) {
  return (
    <>
      <div className="cat-block">
        <div className="cat-block-head">
          <span className="lbl">Места · {pool.locations.length}</span>
          <span className="mono faint cat-block-note">текст уходит в промпты по-английски</span>
        </div>
        <ul className="cat-places cat-places-ro">
          {pool.locations.map((place) => (
            <li key={place.name} className="cat-place">
              <PlaceRow place={place} />
            </li>
          ))}
        </ul>
      </div>
      <div className="cat-block">
        <span className="lbl">Наряды · {pool.outfits.length}</span>
        <div className="cat-outfits">
          {pool.outfits.map((o) => (
            <span key={o} lang="en" className="tag tag-o cat-outfit">
              {o}
            </span>
          ))}
        </div>
      </div>
      <ShotShares pool={pool} />
    </>
  );
}

/** A place in the sheet: its × removes it (free), or says in its title why it cannot. */
export function EditablePlace({ pool, index, busy, onRemove }: { pool: CategoryPool; index: number; busy: boolean; onRemove: (name: string) => void }) {
  const place = pool.locations[index];
  if (place === undefined) return null;
  const refusal = placeRemoval(pool, index);
  const unavailable = refusal !== null || busy;
  return (
    <li className="cat-place cat-place-edit">
      <PlaceRow
        place={place}
        aside={
          <button
            type="button"
            className="xbtn"
            data-remove="place"
            aria-label={`Убрать место: ${place.name}`}
            aria-disabled={unavailable}
            title={refusal ?? "Убрать место"}
            onClick={() => {
              if (!unavailable) onRemove(place.name);
            }}
          >
            <Icon name="close" size={11} strokeWidth={2.6} />
          </button>
        }
      />
    </li>
  );
}
