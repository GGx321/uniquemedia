import type { Clock } from "./ledger";
import type { PriceBook } from "./prices";

/** The models one estimate or job is priced for. */
export interface PriceModels {
  imageModels: readonly string[];
  chatModels: readonly string[];
}

/** A price book and the day its prices are from: the load's UTC day, or the fallback table's date. */
export interface PricedBook {
  book: PriceBook;
  asOf: string;
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
    const wanted = { imageModels: unique(models.imageModels), chatModels: unique(models.chatModels) };
    const key = JSON.stringify(wanted);
    const entry = this.#entries.get(key);
    if (entry !== undefined && this.#monotonic() - entry.loadedAtMono < this.#ttl(entry.priced)) return Promise.resolve(entry.priced);
    const pending = this.#loading.get(key);
    if (pending !== undefined) return pending;

    const loading = this.#load(wanted).then((book) => {
      const priced = { book, asOf: book.fallbackDate ?? new Date(this.#clock()).toISOString().slice(0, 10) };
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
    const key = JSON.stringify({ imageModels: unique(models.imageModels), chatModels: unique(models.chatModels) });
    return this.#entries.get(key)?.priced ?? null;
  }

  #ttl(priced: PricedBook): number {
    return priced.book.source === "live" ? LIVE_PRICES_TTL_MS : FALLBACK_PRICES_TTL_MS;
  }
}
