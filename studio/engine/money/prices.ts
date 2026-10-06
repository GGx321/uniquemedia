import { z } from "zod";
import { MoneyError } from "./errors";
import { costToMicrosCeil } from "./settleRule";
import { timeoutSignal } from "./timeoutSignal";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
/** The day the fallback table was read from OpenRouter (spike results, 2026-09-24). */
export const FALLBACK_PRICES_DATE = "2026-09-24";
/** Each price GET gives up after this long; its model then falls back to the dated table. */
export const PRICE_FETCH_TIMEOUT_MS = 15_000;

export type ImageQuality = "low" | "medium";
export type PriceSource = "live" | "fallback";

export interface ImagePrice {
  /** Output-image prices by variant (`low_1k`, `2k`, `high_resolution`, …; null = no variant). */
  outputs: { variant: string | null; micros: number }[];
  /**
   * Price of one input (reference) image: the highest of the endpoints' `input_image` rows. `null` when some endpoint lists NO such
   * row: the price of a reference is then unknown, never free, and a request that carries one cannot be reserved (`imageWorstCase`).
   * An explicit row of 0 is a price the provider states, and is kept as 0.
   */
  inputImageMicros: number | null;
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

/** The requests Studio sends an image model (openrouter/image.ts): a photo run's 1K, 9:16 and one reference; an avatar portrait's 3:4 and none. */
export const WANTED_RESOLUTION = "1K";
export const PHOTO_ASPECT_RATIO = "9:16";
export const PORTRAIT_ASPECT_RATIO = "3:4";
/** A photo run's master portrait is the one reference; a candidate portrait sends none. */
export const PHOTO_REFERENCES = 1;

const EnumParam = z.object({ values: z.array(z.string()) });
const RangeParam = z.object({ max: z.number() });
export { EnumParam, RangeParam };

/** What `/endpoints` says an endpoint accepts. An absent key means unsupported. */
export const EndpointParams = z.object({
  supported_parameters: z.object({
    resolution: EnumParam.optional(),
    aspect_ratio: EnumParam.optional(),
    quality: EnumParam.optional(),
    input_references: RangeParam.extend({ min: z.number().optional() }).optional(),
  }),
});
export const EndpointsParams = z.object({ endpoints: z.array(EndpointParams).min(1) });

/**
 * True when EVERY endpoint accepts both requests Studio sends: a photo (1K,
 * 9:16, one reference) and an avatar portrait (3:4, no reference at all, so
 * `input_references.min` must be stated and be 0). The catalogue offers a
 * model only then, and a run rechecks it when it loads the price. A body that
 * does not parse is refused.
 */
export function endpointsAcceptRequests(body: unknown): boolean {
  const params = EndpointsParams.safeParse(body);
  if (!params.success) return false;
  return params.data.endpoints.every(({ supported_parameters: p }) => acceptsRequests(p));
}

export function acceptsRequests(p: z.infer<typeof EndpointParams>["supported_parameters"]): boolean {
  return (
    p.resolution?.values.includes(WANTED_RESOLUTION) === true &&
    p.aspect_ratio?.values.includes(PHOTO_ASPECT_RATIO) === true &&
    p.aspect_ratio.values.includes(PORTRAIT_ASPECT_RATIO) &&
    p.input_references?.min === 0 &&
    p.input_references.max >= PHOTO_REFERENCES
  );
}

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
 * bill is not a worst case. An output_image price of 0 throws too (it would
 * reserve nothing), and a model any of whose endpoints lists no input_image
 * row gets `inputImageMicros: null`, not 0 (see `ImagePrice`).
 */
export function parseImageEndpoints(body: unknown, model: string): ImagePrice {
  const parsed = EndpointsBody.safeParse(body);
  if (!parsed.success) throw new Error(`Unexpected endpoints body for ${model}: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.id !== model) throw new Error(`Endpoints body is for ${parsed.data.id}, expected ${model}`);

  const outputs = new Map<string | null, number>();
  let inputImageMicros: number | null = 0;
  for (const endpoint of parsed.data.endpoints) {
    let listsInput = false;
    for (const entry of endpoint.pricing) {
      if (entry.unit !== undefined && entry.unit !== "image") {
        throw new Error(`${model}: ${entry.billable} is priced per ${entry.unit}, not per image`);
      }
      // The price book feeds the RESERVE: read up, never under the bill by a micro-dollar (the settle path rounds to nearest).
      const micros = costToMicrosCeil(entry.cost_usd);
      if (entry.billable === "output_image") {
        if (micros === 0) throw new Error(`${model}: output_image is priced 0, which would reserve nothing`);
        const variant = entry.variant ?? null;
        outputs.set(variant, Math.max(outputs.get(variant) ?? 0, micros));
      } else if (entry.billable === "input_image") {
        listsInput = true;
        inputImageMicros = inputImageMicros === null ? null : Math.max(inputImageMicros, micros);
      } else {
        throw new Error(`${model}: unsupported billable "${entry.billable}"`);
      }
    }
    if (!listsInput) inputImageMicros = null;
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

/** `1k`, `1.5k`, `low_2k`, `768`, `high_resolution`, … — the variant names whose resolution can be read. A leading-zero tier (`01k`, `02k`) is not one: it is unrecognised, so the dearest price is reserved. */
const RECOGNISED_VARIANT = /^(?:(?:[a-z]+_)?(?:0|[1-9]\d*)(?:\.\d+)?k|[1-9]\d{2}|high_resolution)$/;
/** Tiers named by a pixel size or a fractional K (`768`, `1.5k`): they sit around 1K, so a base price beside them is not known to be the 1K one. */
const AROUND_1K_TIER = /^(?:(?:[a-z]+_)?\d+\.\d+k|\d{3})$/;

/** `2k`, `medium_4k`, `high_resolution`: tiers above 1K, which Studio never requests. */
function isLargerThan1k(variant: string | null): boolean {
  if (variant === null) return false;
  if (variant === "high_resolution") return true;
  const k = /^(?:[a-z]+_)?(\d+(?:\.\d+)?)k$/.exec(variant);
  return k !== null && Number(k[1]) >= 2;
}

/**
 * Output price of a 1K image at a quality, never an underestimate: Studio
 * only ever asks for 1K (owner decision 2026-09-29: 2K removed), so a live
 * price list's 2K, 4K and `high_resolution` tiers are parsed but never
 * priced. Variant names are compared in lower case. Any unrecognised
 * variant: the dearest price (nothing can be mapped safely). Otherwise, in
 * order:
 * - `<quality>_1k` variants exist: the exact `<quality>_1k` price; with no
 *   quality, the dearest price below 2K (a `medium_1.5k` or `768` tier beside
 *   `low_1k` must not be skipped; fix round 3); with a quality that has no
 *   `_1k` price, the dearest of ALL variants, 2K included;
 * - a `1k` variant;
 * - tiers named `768` or `1.5k` with no `1k` tier: nothing says which price a
 *   1K request pays, so the dearest price (review round 1, M2);
 * - the variant-less base price (Seedream: base = 1K, `high_resolution` =
 *   2K);
 * - otherwise the dearest price.
 */
export function imageOutputMicros(price: ImagePrice, quality: ImageQuality | null): number {
  const outputs = price.outputs.map((o) => ({ variant: o.variant === null ? null : o.variant.toLowerCase(), micros: o.micros }));
  const dearest = (list: ImagePrice["outputs"]): number => list.reduce((max, o) => Math.max(max, o.micros), 0);
  if (outputs.some((o) => o.variant !== null && !RECOGNISED_VARIANT.test(o.variant))) return dearest(outputs);

  const find = (variant: string | null): number | undefined => outputs.find((o) => o.variant === variant)?.micros;
  const base = find(null);
  const withQuality = outputs.filter((o) => o.variant?.endsWith("_1k"));
  if (withQuality.length > 0) {
    const exact = quality === null ? undefined : find(`${quality}_1k`);
    if (exact !== undefined) return exact;
    // No quality: Studio never requests 2K+, so those tiers are skipped. A quality with no 1K price: only the dearest
    // of ALL variants is a safe upper bound.
    return dearest(quality === null ? outputs.filter((o) => !isLargerThan1k(o.variant)) : outputs);
  }
  const plain = find("1k");
  if (plain !== undefined) return plain;
  if (outputs.some((o) => o.variant !== null && AROUND_1K_TIER.test(o.variant))) return dearest(outputs);
  if (base !== undefined) return base;
  return dearest(outputs);
}

export function imageWorstCase(price: ImagePrice, req: Omit<ImageWorstCaseRequest, "model">): number {
  assertCount("refs", req.refs);
  if (req.refs > 0 && price.inputImageMicros === null) {
    throw new MoneyError("PRICE_UNAVAILABLE", "the endpoints list no input_image price: the price of a reference image is unknown, so a request with one cannot be reserved");
  }
  return imageOutputMicros(price, req.quality) + req.refs * (price.inputImageMicros ?? 0);
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
export const FALLBACK_IMAGE: ReadonlyMap<string, ImagePrice> = new Map([
  [
    "x-ai/grok-imagine-image-2.0",
    {
      outputs: [
        { variant: "low_1k", micros: 40_000 },
        { variant: "medium_1k", micros: 60_000 },
      ],
      inputImageMicros: 10_000,
    },
  ],
  [
    "x-ai/grok-imagine-image-quality",
    {
      outputs: [{ variant: "1k", micros: 50_000 }],
      inputImageMicros: 10_000,
    },
  ],
  [
    "bytedance-seed/seedream-5-0-pro",
    {
      outputs: [{ variant: null, micros: 45_000 }],
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

export async function getJson(fetch: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  // timeoutSignal(), not AbortSignal.timeout(): the latter's own timer is
  // unref'd, which hung the Windows CI runs once M6 moved these tests onto
  // Bun's native AbortController/AbortSignal (timeoutSignal.ts's own doc
  // comment has the full story). Cleared in the finally below either way.
  const timeout = timeoutSignal(timeoutMs);
  try {
    const res = await fetch(url, { signal: timeout.signal });
    if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
    return await res.json();
  } finally {
    timeout.clear();
  }
}

async function liveOrFallback<T>(model: string, table: ReadonlyMap<string, T>, load: () => Promise<T>): Promise<PriceEntry<T>> {
  try {
    return { price: await load(), source: "live" };
  } catch (err) {
    // A refusal that is already a money error (the endpoints read fine and say no) is the answer: the table stands in for a failed read only.
    if (err instanceof MoneyError) throw err;
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
 * parse. Every GET runs at once, each with its own timeout, so a load takes
 * at most one timeout. A model missing from both throws PRICE_UNAVAILABLE.
 */
export async function loadPriceBook(opts: {
  fetch: FetchLike;
  baseUrl: string;
  imageModels: readonly string[];
  chatModels: readonly string[];
  /**
   * A run's load: every image model's LIVE endpoints must still accept the requests Studio sends (`endpointsAcceptRequests`),
   * else PRICE_UNAVAILABLE (never the dated table, which only stands in for a fetch that failed). Without it every attempt of a
   * run on a model that dropped 9:16 would get its own free 400, slot by slot.
   */
  checkRequestShape?: boolean;
  /** Per GET; PRICE_FETCH_TIMEOUT_MS unless a test shortens it. */
  timeoutMs?: number;
}): Promise<PriceBook> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? PRICE_FETCH_TIMEOUT_MS;
  const images = Promise.all(
    opts.imageModels.map(async (model) => {
      const entry = await liveOrFallback(model, FALLBACK_IMAGE, async () => {
        const body = await getJson(opts.fetch, `${base}/images/models/${model}/endpoints`, timeoutMs);
        const price = parseImageEndpoints(body, model);
        if (opts.checkRequestShape === true && !endpointsAcceptRequests(body)) {
          throw new MoneyError("PRICE_UNAVAILABLE", `${model}'s endpoints no longer accept Studio's request (1K, 9:16 and one reference for a photo; 3:4 and none for a portrait)`);
        }
        return price;
      });
      return [model, entry] as const;
    })
  );
  // One /models fetch serves every chat model; a failure falls back per model.
  const models: Promise<{ ok: true; body: unknown } | { ok: false; error: unknown }> =
    opts.chatModels.length === 0
      ? Promise.resolve({ ok: false, error: new Error("no chat model asked for") })
      : getJson(opts.fetch, `${base}/models`, timeoutMs).then(
          (body) => ({ ok: true, body }),
          (error: unknown) => ({ ok: false, error })
        );

  const [imageEntries, listed] = await Promise.all([images, models]);
  const chat = new Map<string, PriceEntry<ChatPrice>>();
  for (const model of opts.chatModels) {
    const entry = await liveOrFallback(model, FALLBACK_CHAT, async () => {
      if (!listed.ok) throw listed.error;
      return parseChatModels(listed.body, model);
    });
    chat.set(model, entry);
  }
  return new PriceBook(new Map(imageEntries), chat);
}
