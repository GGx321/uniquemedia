import { z } from "zod";
import { ImageModelCatalogue, ImageModelEntry, ImageQuality, ModelId } from "../../shared/engine";
import type { Clock } from "../money/ledger";
import { FALLBACK_IMAGE, getJson, imageWorstCase, parseImageEndpoints, PRICE_FETCH_TIMEOUT_MS, type FetchLike, type ImagePrice } from "../money/prices";

// The image models Settings offers (docs/studio/2026-10-05-image-models.md has
// the research behind every rule here). A model is listed only when the exact
// request photo runs send (1K, 9:16, one reference image) is valid for it AND
// its price is a per-image figure the ledger can bound. Everything is decided
// from two free, public GETs: `/images/models` (names, a cheap pre-filter on
// the union of the endpoints' parameters) and each candidate's
// `/images/models/<id>/endpoints` (the definitive per-endpoint parameters and
// pricing, the same body the price book reads).

/** The contract's cap on the catalogue (`ImageModelCatalogue`): a longer live list is cut to it, never refused whole. */
export const MAX_CATALOGUE_MODELS = 100;

/** A live catalogue is read again after this long. */
export const LIVE_CATALOGUE_TTL_MS = 30 * 60_000;
/** A bundled or partial catalogue retries the live read sooner: the outage may be over. */
export const FALLBACK_CATALOGUE_TTL_MS = 60_000;

/** The request's fixed shape (openrouter/image.ts): the size and the aspect ratio a model must accept. */
const WANTED_RESOLUTION = "1K";
const WANTED_ASPECT_RATIO = "9:16";
/** A photo run's master portrait is the one reference; a candidate portrait sends none. */
const PHOTO_REFERENCES = 1;

const EnumParam = z.object({ values: z.array(z.string()) });
const RangeParam = z.object({ max: z.number() });
const Modalities = z.array(z.string());

const ListedModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  architecture: z.object({ input_modalities: Modalities, output_modalities: Modalities }),
  supported_parameters: z.object({
    resolution: EnumParam.optional(),
    aspect_ratio: EnumParam.optional(),
    input_references: RangeParam.optional(),
  }),
});
const ListBody = z.object({ data: z.array(z.unknown()) });

/** What `/endpoints` says an endpoint accepts. An absent key means unsupported. */
const EndpointParams = z.object({
  supported_parameters: z.object({
    resolution: EnumParam.optional(),
    aspect_ratio: EnumParam.optional(),
    quality: EnumParam.optional(),
    input_references: RangeParam.optional(),
  }),
});
const EndpointsParams = z.object({ endpoints: z.array(EndpointParams).min(1) });

export interface ListedImageModel {
  id: string;
  name: string;
}

/** The models of `/images/models` that could take the request: text+image in, image out, and the union of parameters allows it. */
export function listedCandidates(body: unknown): ListedImageModel[] | null {
  const list = ListBody.safeParse(body);
  if (!list.success) return null;
  const candidates: ListedImageModel[] = [];
  for (const item of list.data.data) {
    const parsed = ListedModel.safeParse(item);
    if (!parsed.success) continue;
    const { id, name, architecture, supported_parameters: p } = parsed.data;
    const takesRequest =
      architecture.input_modalities.includes("image") &&
      architecture.output_modalities.length === 1 &&
      architecture.output_modalities[0] === "image" &&
      p.resolution?.values.includes(WANTED_RESOLUTION) === true &&
      p.aspect_ratio?.values.includes(WANTED_ASPECT_RATIO) === true &&
      (p.input_references?.max ?? 0) >= PHOTO_REFERENCES;
    // The id goes into a URL (`/images/models/<id>/endpoints`) and into the contract: one that is not a model id is never used.
    if (takesRequest && ModelId.safeParse(id).success) candidates.push({ id, name: displayName(name) });
  }
  return candidates;
}

/** "ByteDance Seed: Seedream 5.0 Flash" -> "Seedream 5.0 Flash": the provider is in the id, the select is short. */
function displayName(name: string): string {
  const at = name.indexOf(": ");
  const rest = at === -1 ? name : name.slice(at + 2);
  return rest.trim().length > 0 ? rest.trim() : name;
}

function tested(id: string): boolean {
  return FALLBACK_IMAGE.has(id);
}

/** The photo price of each quality: output at that quality plus one reference image, at 1K; the worst case the run is estimated by. */
function entryOf(listed: ListedImageModel, qualities: ImageQuality[], price: ImagePrice): ImageModelEntry {
  // A photo run sends one reference, so the price of one must be listed (an explicit 0 is a stated price): `imageWorstCase` refuses otherwise.
  const priceOf = (quality: ImageQuality | null) => ({ quality, micros: imageWorstCase(price, { quality, refs: PHOTO_REFERENCES }) });
  return {
    id: listed.id,
    name: listed.name,
    qualities,
    prices: qualities.length === 0 ? [priceOf(null)] : qualities.map(priceOf),
    tested: tested(listed.id),
  };
}

/**
 * One candidate's entry from its `/endpoints` body, or null when it is not
 * selectable: some endpoint refuses 1K, 9:16 or a reference, or the pricing
 * is anything the price book refuses (per token, per megapixel, a reference
 * billed per request, no price at all). `qualities` are the ones EVERY
 * endpoint lists, of the two the contract knows; none when the model has no
 * quality knob, which the request then never sends.
 */
export function entryFromEndpoints(listed: ListedImageModel, body: unknown): ImageModelEntry | null {
  const params = EndpointsParams.safeParse(body);
  if (!params.success) return null;
  const endpoints = params.data.endpoints.map((e) => e.supported_parameters);
  const takesRequest = endpoints.every(
    (p) =>
      p.resolution?.values.includes(WANTED_RESOLUTION) === true &&
      p.aspect_ratio?.values.includes(WANTED_ASPECT_RATIO) === true &&
      (p.input_references?.max ?? 0) >= PHOTO_REFERENCES,
  );
  if (!takesRequest) return null;
  let price: ImagePrice;
  try {
    price = parseImageEndpoints(body, listed.id);
  } catch {
    return null;
  }
  // Review round 1, M1: no input_image row means the price of the reference is unknown, not free; such a model is never offered.
  if (price.inputImageMicros === null) return null;
  const qualities = ImageQuality.options.filter((q) => endpoints.every((p) => p.quality?.values.includes(q) === true));
  return entryOf(listed, qualities, price);
}

/** Tested models first (the ones the owner has seen work), then the rest by name. */
function ordered(models: ImageModelEntry[]): ImageModelEntry[] {
  return [...models].sort((a, b) => Number(b.tested) - Number(a.tested) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

const FALLBACK_NAMES: ReadonlyMap<string, string> = new Map([
  ["x-ai/grok-imagine-image-2.0", "Grok Imagine Image 2.0"],
  ["x-ai/grok-imagine-image-quality", "Grok Imagine Image Quality"],
  ["bytedance-seed/seedream-5-0-pro", "Seedream 5.0 Pro"],
]);

/**
 * The bundled list, for when OpenRouter's own cannot be read: exactly the
 * models of the dated price table (money/prices.ts), at its prices, so a run
 * on any of them still has a price when the endpoints GET also fails. The
 * qualities are the ones the fixtures show (only grok-imagine-image-2.0 has a
 * knob). No other model is listed here: a model with no dated price could not
 * be priced offline anyway.
 */
export function fallbackImageCatalogue(): ImageModelCatalogue {
  const models = [...FALLBACK_IMAGE].filter(([, price]) => price.inputImageMicros !== null).map(([id, price]) => {
    const qualities: ImageQuality[] = price.outputs.some((o) => o.variant?.startsWith("low_") === true) ? ["low", "medium"] : [];
    return entryOf({ id, name: FALLBACK_NAMES.get(id) ?? id }, qualities, price);
  });
  return { models: ordered(models), source: "fallback" };
}

/** A built catalogue, and whether every candidate was priced (a transient failure leaves it partial, so it is tried again soon). */
export interface CatalogueLoad {
  catalogue: ImageModelCatalogue;
  complete: boolean;
}

/**
 * Builds the catalogue from OpenRouter: the model list, then every candidate's
 * endpoints at once, each GET with its own timeout. A candidate whose GET
 * fails or whose body cannot be used is left out (not selectable without a
 * price). A list that cannot be read, or one where nothing could be priced,
 * gives the bundled list.
 */
export async function loadImageCatalogue(opts: { fetch: FetchLike; baseUrl: string; timeoutMs?: number }): Promise<CatalogueLoad> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? PRICE_FETCH_TIMEOUT_MS;
  const bundled: CatalogueLoad = { catalogue: fallbackImageCatalogue(), complete: false };
  let candidates: ListedImageModel[] | null;
  try {
    candidates = listedCandidates(await getJson(opts.fetch, `${base}/images/models`, timeoutMs));
  } catch {
    return bundled;
  }
  if (candidates === null) return bundled;
  const answers = await Promise.all(
    candidates.map(async (listed) => {
      try {
        const body = await getJson(opts.fetch, `${base}/images/models/${listed.id}/endpoints`, timeoutMs);
        return { reached: true, entry: entryFromEndpoints(listed, body) };
      } catch {
        return { reached: false, entry: null };
      }
    }),
  );
  // One entry the contract refuses (a name over 120 characters, say) is dropped alone: the whole answer failing the schema would
  // reject the catalogue, and a full live one would be cached for 30 minutes. The list is cut to the contract's cap, tested first.
  const models = ordered(answers.flatMap((a) => (a.entry === null || !ImageModelEntry.safeParse(a.entry).success ? [] : [a.entry]))).slice(0, MAX_CATALOGUE_MODELS);
  if (models.length === 0) return bundled;
  return { catalogue: { models, source: "live" }, complete: answers.every((a) => a.reached) };
}

/** The catalogue for the engine's life: served from memory until its refresh time; requests during a load share it; a failed load is not cached. */
export class ImageCatalogueCache {
  readonly #load: () => Promise<CatalogueLoad>;
  readonly #monotonic: Clock;
  #entry: { load: CatalogueLoad; at: number } | null = null;
  #loading: Promise<ImageModelCatalogue> | null = null;

  constructor(opts: { load: () => Promise<CatalogueLoad>; monotonic: Clock }) {
    this.#load = opts.load;
    this.#monotonic = opts.monotonic;
  }

  get(): Promise<ImageModelCatalogue> {
    const entry = this.#entry;
    if (entry !== null) {
      const ttl = entry.load.catalogue.source === "live" && entry.load.complete ? LIVE_CATALOGUE_TTL_MS : FALLBACK_CATALOGUE_TTL_MS;
      if (this.#monotonic() - entry.at < ttl) return Promise.resolve(entry.load.catalogue);
    }
    if (this.#loading !== null) return this.#loading;
    const loading = this.#load().then((load) => {
      this.#entry = { load, at: this.#monotonic() };
      return load.catalogue;
    });
    this.#loading = loading;
    const forget = (): void => {
      this.#loading = null;
    };
    loading.then(forget, forget);
    return loading;
  }
}
