import { z } from "zod";
import { MoneyError } from "./errors";
import { costToMicros } from "./settleRule";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
/** The day the fallback table was read from OpenRouter (spike results, 2026-09-24). */
export const FALLBACK_PRICES_DATE = "2026-09-24";
const PRICE_FETCH_TIMEOUT_MS = 15_000;

export type Resolution = "1K" | "2K";
export type ImageQuality = "low" | "medium";
export type PriceSource = "live" | "fallback";

export interface ImagePrice {
  /** Output-image prices by variant (`low_1k`, `2k`, `high_resolution`, …; null = no variant). */
  outputs: { variant: string | null; micros: number }[];
  /** Price of one input (reference) image. */
  inputImageMicros: number;
}

/**
 * Chat rates in picodollars (1e-12 USD) per unit, so per-token prices stay
 * integers: "0.0000025" USD per token = 2_500_000 pico$ per token (numerically
 * µ$ per million tokens). `image` is per input image, `request` per request.
 */
export interface ChatRates {
  promptPico: number;
  completionPico: number;
  imagePico: number;
  requestPico: number;
}

export interface ChatPrice extends ChatRates {
  /** Rates from `min_prompt_tokens` on, as listed in `pricing.overrides`; fields not listed keep the base rate. */
  overrides: ({ minPromptTokens: number } & ChatRates)[];
}

export interface ImageWorstCaseRequest {
  model: string;
  resolution: Resolution;
  quality: ImageQuality | null;
  refs: number;
}

export interface ChatWorstCaseRequest {
  model: string;
  maxTokens: number;
  /** Estimated prompt tokens, images included. */
  inputTokens: number;
  /** Input images, for models with a per-image price. */
  images: number;
}

/** The subset of `fetch` the price loader needs; the global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ---------- /api/v1/images/models/<id>/endpoints ----------

const PricingEntry = z.object({
  billable: z.string(),
  unit: z.string().optional(),
  cost_usd: z.number().finite().nonnegative(),
  variant: z.string().nullish(),
});
const EndpointsBody = z.object({
  id: z.string(),
  endpoints: z.array(z.object({ pricing: z.array(PricingEntry) })).min(1),
});

/**
 * Image pricing of one model. When several providers serve it, each variant
 * takes the highest price. A billable other than output_image/input_image, or
 * a unit other than "image", throws: a worst case that ignores part of the
 * bill is not a worst case.
 */
export function parseImageEndpoints(body: unknown, model: string): ImagePrice {
  const parsed = EndpointsBody.safeParse(body);
  if (!parsed.success) throw new Error(`Unexpected endpoints body for ${model}: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.id !== model) throw new Error(`Endpoints body is for ${parsed.data.id}, expected ${model}`);

  const outputs = new Map<string | null, number>();
  let inputImageMicros = 0;
  for (const endpoint of parsed.data.endpoints) {
    for (const entry of endpoint.pricing) {
      if (entry.unit !== undefined && entry.unit !== "image") {
        throw new Error(`${model}: ${entry.billable} is priced per ${entry.unit}, not per image`);
      }
      const micros = costToMicros(entry.cost_usd);
      if (entry.billable === "output_image") {
        const variant = entry.variant ?? null;
        outputs.set(variant, Math.max(outputs.get(variant) ?? 0, micros));
      } else if (entry.billable === "input_image") {
        inputImageMicros = Math.max(inputImageMicros, micros);
      } else {
        throw new Error(`${model}: unsupported billable "${entry.billable}"`);
      }
    }
  }
  if (outputs.size === 0) throw new Error(`${model}: no output_image price`);
  return { outputs: [...outputs].map(([variant, micros]) => ({ variant, micros })), inputImageMicros };
}

// ---------- /api/v1/models (chat) ----------

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const ModelsBody = z.object({ data: z.array(z.unknown()) });
const HasId = z.object({ id: z.string() });
const ChatModelEntry = z.object({
  pricing: z.record(z.string(), z.unknown()),
});
const OverrideEntry = z.record(z.string(), z.unknown()).and(z.object({ min_prompt_tokens: z.int().nonnegative() }));

/** Pricing fields a worst case may ignore: web search is never enabled, cache reads are cheaper than prompt tokens, nothing asks for cache writes. */
const IGNORED_PRICING_FIELDS: ReadonlySet<string> = new Set(["web_search", "input_cache_read", "input_cache_write", "input_cache_write_1h"]);
const RATE_FIELDS: ReadonlyMap<string, keyof ChatRates> = new Map([
  ["prompt", "promptPico"],
  ["completion", "completionPico"],
  ["image", "imagePico"],
  ["request", "requestPico"],
]);

/** "0.0000025" USD -> 2_500_000 pico$, exactly (no float); digits beyond 1e-12 round up. */
function usdToPico(usd: string): number {
  const match = DECIMAL.exec(usd);
  if (!match) throw new Error(`"${usd}" is not a plain non-negative decimal`);
  const fraction = match[2] ?? "";
  let scaled = BigInt(match[1]) * 10n ** 12n + BigInt(fraction.slice(0, 12).padEnd(12, "0"));
  if (/[1-9]/.test(fraction.slice(12))) scaled += 1n;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`"${usd}" is out of range`);
  return Number(scaled);
}

function isZero(value: unknown): boolean {
  return value === 0 || (typeof value === "string" && /^0+(?:\.0+)?$/.test(value));
}

/**
 * Reads the rate fields of a pricing object on top of `base`. Allowlisted and
 * zero-valued fields are ignored; any other non-zero field throws, because a
 * worst case that leaves part of the bill out is not a worst case.
 */
function ratesOf(pricing: Record<string, unknown>, where: string, base: ChatRates): ChatRates {
  const rates: ChatRates = { ...base };
  const unbounded: string[] = [];
  for (const [key, value] of Object.entries(pricing)) {
    if (key === "overrides" || key === "min_prompt_tokens") continue;
    const rate = RATE_FIELDS.get(key);
    if (rate !== undefined) {
      if (typeof value !== "string") throw new Error(`${where} pricing.${key} is not a decimal string`);
      try {
        rates[rate] = usdToPico(value);
      } catch (err) {
        throw new Error(`${where} pricing.${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (!IGNORED_PRICING_FIELDS.has(key) && !isZero(value)) {
      unbounded.push(key);
    }
  }
  if (unbounded.length > 0) throw new Error(`${where} pricing has fields the worst case cannot bound: ${unbounded.join(", ")}`);
  return rates;
}

/** Chat pricing of one model from the `/models` list; other entries are not validated. */
export function parseChatModels(body: unknown, model: string): ChatPrice {
  const list = ModelsBody.safeParse(body);
  if (!list.success) throw new Error(`Unexpected /models body: ${z.prettifyError(list.error)}`);
  const entry = list.data.data.find((item) => {
    const withId = HasId.safeParse(item);
    return withId.success && withId.data.id === model;
  });
  if (entry === undefined) throw new Error(`${model} is not listed in /models`);
  const parsed = ChatModelEntry.safeParse(entry);
  if (!parsed.success) throw new Error(`/models pricing for ${model} is invalid: ${z.prettifyError(parsed.error)}`);

  const { pricing } = parsed.data;
  if (!("prompt" in pricing) || !("completion" in pricing)) throw new Error(`/models pricing for ${model} lacks prompt or completion`);
  const where = `/models ${model}`;
  const base = ratesOf(pricing, where, { promptPico: 0, completionPico: 0, imagePico: 0, requestPico: 0 });

  const rawOverrides = z.array(OverrideEntry).optional().safeParse(pricing.overrides);
  if (!rawOverrides.success) throw new Error(`${where} pricing.overrides is invalid: ${z.prettifyError(rawOverrides.error)}`);
  const overrides = (rawOverrides.data ?? [])
    .map((o) => ({ minPromptTokens: o.min_prompt_tokens, ...ratesOf(o, `${where} override`, base) }))
    .sort((a, b) => a.minPromptTokens - b.minPromptTokens);
  return { ...base, overrides };
}

// ---------- worst cases ----------

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer, got ${value}`);
}

/** `1k`, `low_2k`, `high_resolution`, … — the variant names whose resolution can be read. */
const RECOGNISED_VARIANT = /^(?:(?:[a-z]+_)?\d+k|high_resolution)$/;

/**
 * Output price for a resolution and quality, never an underestimate; variant
 * names are compared in lower case. Any unrecognised variant: the dearest
 * price (nothing can be mapped safely). Otherwise, in order:
 * - `<quality>_<res>` variants exist: the requested quality; if it is missing
 *   or null, the dearest of them or the base price, whichever is higher;
 * - a `<res>` variant; for 2K, `high_resolution`;
 * - no variant for this resolution: the variant-less base price only for 1K,
 *   the lowest resolution, which the base must cover (Seedream: base = 1K,
 *   `high_resolution` = 2K); for 2K the dearest price (e.g. `{base, 4k}`).
 */
function outputMicros(price: ImagePrice, resolution: Resolution, quality: ImageQuality | null): number {
  const res = resolution === "1K" ? "1k" : "2k";
  const outputs = price.outputs.map((o) => ({ variant: o.variant === null ? null : o.variant.toLowerCase(), micros: o.micros }));
  const dearest = (list: ImagePrice["outputs"]): number => list.reduce((max, o) => Math.max(max, o.micros), 0);
  if (outputs.some((o) => o.variant !== null && !RECOGNISED_VARIANT.test(o.variant))) return dearest(outputs);

  const find = (variant: string | null): number | undefined => outputs.find((o) => o.variant === variant)?.micros;
  const base = find(null);
  const withQuality = outputs.filter((o) => o.variant?.endsWith(`_${res}`));
  if (withQuality.length > 0) {
    const exact = quality === null ? undefined : find(`${quality}_${res}`);
    return exact ?? Math.max(dearest(withQuality), base ?? 0);
  }
  const plain = find(res);
  if (plain !== undefined) return plain;
  if (res === "2k") {
    const high = find("high_resolution");
    if (high !== undefined) return high;
  }
  if (res === "1k" && base !== undefined) return base;
  return dearest(outputs);
}

export function imageWorstCase(price: ImagePrice, req: Omit<ImageWorstCaseRequest, "model">): number {
  assertCount("refs", req.refs);
  return outputMicros(price, req.resolution, req.quality) + req.refs * price.inputImageMicros;
}

/** Cost of one chat call with these token and image counts, rounded up to a whole micro-dollar. */
export function chatCost(price: ChatPrice, req: { inputTokens: number; outputTokens: number; images: number }): number {
  assertCount("inputTokens", req.inputTokens);
  assertCount("outputTokens", req.outputTokens);
  assertCount("images", req.images);
  let rates: ChatRates = price;
  let threshold = -1;
  for (const o of price.overrides) {
    if (req.inputTokens >= o.minPromptTokens && o.minPromptTokens > threshold) {
      threshold = o.minPromptTokens;
      rates = o;
    }
  }
  const pico =
    BigInt(req.outputTokens) * BigInt(rates.completionPico) +
    BigInt(req.inputTokens) * BigInt(rates.promptPico) +
    BigInt(req.images) * BigInt(rates.imagePico) +
    BigInt(rates.requestPico);
  const micros = (pico + 999_999n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("chat cost is out of range");
  return Number(micros);
}

/** max_tokens × completion + the input estimate × prompt + images × per-image + per-request, rounded up. */
export function chatWorstCase(price: ChatPrice, req: Omit<ChatWorstCaseRequest, "model">): number {
  assertCount("maxTokens", req.maxTokens);
  return chatCost(price, { inputTokens: req.inputTokens, outputTokens: req.maxTokens, images: req.images });
}

// ---------- the dated fallback table ----------

/** Read from /images/models/<id>/endpoints and /models on 2026-09-24 (spike results). Used only when a fetch fails. */
const FALLBACK_IMAGE: ReadonlyMap<string, ImagePrice> = new Map([
  [
    "x-ai/grok-imagine-image-2.0",
    {
      outputs: [
        { variant: "low_1k", micros: 40_000 },
        { variant: "low_2k", micros: 60_000 },
        { variant: "medium_1k", micros: 60_000 },
        { variant: "medium_2k", micros: 80_000 },
      ],
      inputImageMicros: 10_000,
    },
  ],
  [
    "x-ai/grok-imagine-image-quality",
    {
      outputs: [
        { variant: "1k", micros: 50_000 },
        { variant: "2k", micros: 70_000 },
      ],
      inputImageMicros: 10_000,
    },
  ],
  [
    "bytedance-seed/seedream-5-0-pro",
    {
      outputs: [
        { variant: null, micros: 45_000 },
        { variant: "high_resolution", micros: 90_000 },
      ],
      inputImageMicros: 3_000,
    },
  ],
]);

const FALLBACK_CHAT: ReadonlyMap<string, ChatPrice> = new Map([
  [
    "x-ai/grok-4.3",
    {
      promptPico: 1_250_000,
      completionPico: 2_500_000,
      imagePico: 0,
      requestPico: 0,
      overrides: [{ minPromptTokens: 200_000, promptPico: 2_500_000, completionPico: 5_000_000, imagePico: 0, requestPico: 0 }],
    },
  ],
]);

// ---------- the price book ----------

export interface PriceEntry<T> {
  price: T;
  source: PriceSource;
  /** Why the live price could not be used; set only for fallback entries. */
  error?: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Prices for the models of one estimate or run, each flagged live or fallback. */
export class PriceBook {
  private readonly images: ReadonlyMap<string, PriceEntry<ImagePrice>>;
  private readonly chat: ReadonlyMap<string, PriceEntry<ChatPrice>>;

  constructor(images: ReadonlyMap<string, PriceEntry<ImagePrice>>, chat: ReadonlyMap<string, PriceEntry<ChatPrice>>) {
    this.images = images;
    this.chat = chat;
  }

  /** Every model of the fallback table, flagged "fallback". */
  static fallback(): PriceBook {
    const flag = <T>(table: ReadonlyMap<string, T>): Map<string, PriceEntry<T>> =>
      new Map([...table].map(([model, price]) => [model, { price, source: "fallback" as const }]));
    return new PriceBook(flag(FALLBACK_IMAGE), flag(FALLBACK_CHAT));
  }

  /** "fallback" when any model's price came from the table; the UI must say so. */
  get source(): PriceSource {
    for (const entry of [...this.images.values(), ...this.chat.values()]) {
      if (entry.source === "fallback") return "fallback";
    }
    return "live";
  }

  get fallbackDate(): string | null {
    return this.source === "fallback" ? FALLBACK_PRICES_DATE : null;
  }

  sourceOf(model: string): PriceSource {
    const entry = this.images.get(model) ?? this.chat.get(model);
    if (!entry) throw unavailable(model);
    return entry.source;
  }

  imageWorstCase(req: ImageWorstCaseRequest): number {
    const entry = this.images.get(req.model);
    if (!entry) throw unavailable(req.model);
    return imageWorstCase(entry.price, req);
  }

  chatWorstCase(req: ChatWorstCaseRequest): number {
    const entry = this.chat.get(req.model);
    if (!entry) throw unavailable(req.model);
    return chatWorstCase(entry.price, req);
  }

  /** Cost of a chat call with known (e.g. typical) token counts, for expected estimates. */
  chatCost(req: { model: string; inputTokens: number; outputTokens: number; images: number }): number {
    const entry = this.chat.get(req.model);
    if (!entry) throw unavailable(req.model);
    return chatCost(entry.price, req);
  }
}

function unavailable(model: string): MoneyError {
  return new MoneyError("PRICE_UNAVAILABLE", `no price loaded for ${model}`);
}

async function getJson(fetch: FetchLike, url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.json();
}

async function liveOrFallback<T>(model: string, table: ReadonlyMap<string, T>, load: () => Promise<T>): Promise<PriceEntry<T>> {
  try {
    return { price: await load(), source: "live" };
  } catch (err) {
    const fallback = table.get(model);
    if (fallback === undefined) {
      throw new MoneyError(
        "PRICE_UNAVAILABLE",
        `no price for ${model}: the live fetch failed (${describe(err)}) and the ${FALLBACK_PRICES_DATE} fallback table does not list it`
      );
    }
    return { price: fallback, source: "fallback", error: describe(err) };
  }
}

/**
 * Fetches live prices (free, public GETs; no key) and falls back per model to
 * the dated table when a fetch fails, answers non-2xx, or its body does not
 * parse. A model missing from both throws PRICE_UNAVAILABLE.
 */
export async function loadPriceBook(opts: {
  fetch: FetchLike;
  baseUrl: string;
  imageModels: readonly string[];
  chatModels: readonly string[];
}): Promise<PriceBook> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const imageEntries = await Promise.all(
    opts.imageModels.map(async (model) => {
      const entry = await liveOrFallback(model, FALLBACK_IMAGE, async () =>
        parseImageEndpoints(await getJson(opts.fetch, `${base}/images/models/${model}/endpoints`), model)
      );
      return [model, entry] as const;
    })
  );

  const chat = new Map<string, PriceEntry<ChatPrice>>();
  if (opts.chatModels.length > 0) {
    // One /models fetch serves every chat model; a failure falls back per model.
    let models: { ok: true; body: unknown } | { ok: false; error: unknown };
    try {
      models = { ok: true, body: await getJson(opts.fetch, `${base}/models`) };
    } catch (error) {
      models = { ok: false, error };
    }
    for (const model of opts.chatModels) {
      const entry = await liveOrFallback(model, FALLBACK_CHAT, async () => {
        if (!models.ok) throw models.error;
        return parseChatModels(models.body, model);
      });
      chat.set(model, entry);
    }
  }
  return new PriceBook(new Map(imageEntries), chat);
}
