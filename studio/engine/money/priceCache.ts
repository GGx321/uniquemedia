import type { Clock } from "./ledger";
import type { PriceBook } from "./prices";

/** The models one estimate or job is priced for. */
export interface PriceModels {
  imageModels: readonly string[];
  chatModels: readonly string[];
  /** A run's models: the image endpoints are rechecked against Studio's requests (`loadPriceBook`'s `checkRequestShape`). */
  checkRequestShape?: boolean;
  /** 5a.3 (S5.9d): the run has «Смелая» slots, so the Seedream endpoint is also checked for the 2K request. Part of the cache key: a plain load never answers for a bold one. */
  boldShape?: true;
  /** 5b.1 (S5.V2): the video model ids a clip is priced for. Part of the cache key beside `boldShape`; absent or empty keeps every other caller's key byte for byte. */
  videoModels?: readonly string[];
}

/** The models in the one canonical shape the cache keys by (sorted, flags only when set). */
function wantedOf(models: PriceModels): PriceModels {
  return {
    imageModels: unique(models.imageModels),
    chatModels: unique(models.chatModels),
    ...(models.checkRequestShape === true ? { checkRequestShape: true } : {}),
    ...(models.boldShape === true ? { boldShape: true as const } : {}),
    ...(models.videoModels !== undefined && models.videoModels.length > 0 ? { videoModels: unique(models.videoModels) } : {}),
  };
}

/** A price book and the day its prices are from: the load's UTC day, or the fallback table's date. */
export interface PricedBook {
  book: PriceBook;
  asOf: string;
  /**
   * 5b.1 (S5.V2): the day of the VIDEO part alone: the video table's date when it stood in, else the load's day. `asOf` is the older of every dated table in a mixed book (images
   * from the table, video live reads the image table's date), so a clip's estimate reads this one. The cache always sets it; a hand-built value may leave it out.
   */
  videoAsOf?: string;
}

/** Live prices are loaded again after this long. */
export const LIVE_PRICES_TTL_MS = 10 * 60_000;
/** A book with any fallback price retries the live fetch sooner: the outage may be over. */
export const FALLBACK_PRICES_TTL_MS = 60_000;

interface Entry {
  priced: PricedBook;
  /** Monotonic ms of the load: the refresh time survives wall-clock jumps. */
  loadedAtMono: number;
}

function unique(models: readonly string[]): string[] {
  return [...new Set(models)].sort();
}

/**
 * Prices for the engine's life, per set of models. A request within the
 * refresh time is answered from the cache, so an estimate and the paid
 * command that follows it see the same prices; requests during a load share
 * it. A failed load (PRICE_UNAVAILABLE) is not cached.
 */
export class PriceCache {
  readonly #load: (models: PriceModels) => Promise<PriceBook>;
  readonly #clock: Clock;
  readonly #monotonic: Clock;
  readonly #entries = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<PricedBook>>();

  /** `clock` (wall, epoch ms) dates live prices; `monotonic` times the refresh. */
  constructor(opts: { load: (models: PriceModels) => Promise<PriceBook>; clock: Clock; monotonic: Clock }) {
    this.#load = opts.load;
    this.#clock = opts.clock;
    this.#monotonic = opts.monotonic;
  }

  get(models: PriceModels): Promise<PricedBook> {
    const wanted = wantedOf(models);
    const key = JSON.stringify(wanted);
    const entry = this.#entries.get(key);
    if (entry !== undefined && this.#monotonic() - entry.loadedAtMono < this.#ttl(entry.priced)) return Promise.resolve(entry.priced);
    const pending = this.#loading.get(key);
    if (pending !== undefined) return pending;

    const loading = this.#load(wanted).then((book) => {
      const day = new Date(this.#clock()).toISOString().slice(0, 10);
      const priced = { book, asOf: book.fallbackDate ?? day, videoAsOf: book.videoFallbackDate ?? day };
      this.#entries.set(key, { priced, loadedAtMono: this.#monotonic() });
      return priced;
    });
    this.#loading.set(key, loading);
    const forget = (): void => void this.#loading.delete(key);
    loading.then(forget, forget);
    return loading;
  }

  /** The last prices loaded for these models, due for a refresh or not; never loads. */
  peek(models: PriceModels): PricedBook | null {
    const key = JSON.stringify(wantedOf(models));
    return this.#entries.get(key)?.priced ?? null;
  }

  #ttl(priced: PricedBook): number {
    return priced.book.source === "live" ? LIVE_PRICES_TTL_MS : FALLBACK_PRICES_TTL_MS;
  }
}
