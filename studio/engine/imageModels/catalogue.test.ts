import { expect, test } from "bun:test";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ImageModelCatalogue } from "../../shared/engine";
import { FALLBACK_IMAGE, type FetchLike } from "../money/prices";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import {
  FALLBACK_CATALOGUE_TTL_MS,
  fallbackImageCatalogue,
  ImageCatalogueCache,
  TESTED_IMAGE_MODELS,
  LIVE_CATALOGUE_TTL_MS,
  loadImageCatalogue,
  type CatalogueLoad,
} from "./catalogue";
useNativeGlobals();

// Real bodies of the public, free GETs, saved on 2026-10-05: /images/models trimmed to the 13 models below (each entry
// unchanged but its description) and each one's own /endpoints record.
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
}
const LIST = fixture("images-models.json");
const BASE = "https://openrouter.test/api/v1";

function endpointsFile(id: string): string {
  return `endpoints/${id.replace("/", "_")}.json`;
}

interface Fake {
  fetch: FetchLike;
  urls: string[];
}

/** Answers the list and each model's endpoints from the fixtures; `fail` lists the URL suffixes that answer 500 or throw. */
function fakeFetch(opts: { failList?: boolean; failEndpoints?: readonly string[]; throwEndpoints?: readonly string[] } = {}): Fake {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    if (url === `${BASE}/images/models`) {
      if (opts.failList) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => LIST };
    }
    const match = /\/images\/models\/(.+)\/endpoints$/.exec(url);
    const id = match?.[1];
    if (id === undefined) throw new Error(`unexpected GET ${url}`);
    if (opts.throwEndpoints?.includes(id)) throw new Error("network down");
    if (opts.failEndpoints?.includes(id)) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => fixture(endpointsFile(id)) };
  };
  return { fetch, urls };
}

const loadFull = (fake: Fake) => loadImageCatalogue({ fetch: fake.fetch, baseUrl: BASE });
const load = async (fake: Fake) => (await loadFull(fake)).catalogue;
const ids = (c: ImageModelCatalogue) => c.models.map((m) => m.id);

const GROK = "x-ai/grok-imagine-image-2.0";

test("lists exactly the models that take a 1K 9:16 request with a reference, are priced per image, and list a price for that reference", async () => {
  const catalogue = await load(fakeFetch());

  expect(ids(catalogue).sort()).toEqual(
    [
      "bytedance-seed/seedream-5-0-flash",
      "bytedance-seed/seedream-5-0-pro",
      "qwen/qwen-image-3",
      GROK,
      "x-ai/grok-imagine-image-quality",
    ].sort(),
  );
});

test("leaves out a model without a 1K size, one priced per token, one with no price, one with no size parameter, and one billed for a reference per request", async () => {
  const listed = ids(await load(fakeFetch()));

  for (const left of [
    "bytedance-seed/seedream-5-0-lite", // resolution 2K and 4K only
    "openai/gpt-image-2", // per token
    "google/gemini-3-pro-image", // per token
    "krea/krea-2-large", // no pricing lines
    "recraft/recraft-v4", // no resolution parameter
    "sourceful/riverflow-v2-pro", // input_reference and input_font billables
    "black-forest-labs/flux-3-image", // no input_image row: a reference would be billed at an unknown price (review round 1, M1)
    "sourceful/riverflow-v2.5-fast", // the same
  ]) {
    expect(listed).not.toContain(left);
  }
});

// ---------- backlog item 1: avatar portraits and candidates ask for 3:4 and no reference ----------

type EndpointEdit = (params: Record<string, unknown>) => Record<string, unknown>;

/** The fixtures, but `id`'s endpoints edited: `edit` gets each endpoint's `supported_parameters`. */
function fetchEditing(id: string, edit: EndpointEdit): Fake {
  const inner = fakeFetch();
  const fetch: FetchLike = async (url) => {
    if (!url.endsWith(`/images/models/${id}/endpoints`)) return inner.fetch(url);
    inner.urls.push(url);
    const body = z.object({ endpoints: z.array(z.record(z.string(), z.unknown())) }).and(z.record(z.string(), z.unknown())).parse(fixture(endpointsFile(id)));
    const endpoints = body.endpoints.map((e) => ({ ...e, supported_parameters: edit(z.record(z.string(), z.unknown()).parse(e.supported_parameters)) }));
    return { ok: true, status: 200, json: async () => ({ ...body, endpoints }) };
  };
  return { fetch, urls: inner.urls };
}

test("a model whose endpoints do not list the 3:4 aspect ratio is not offered: the avatar portrait asks for it", async () => {
  const without34 = fetchEditing(GROK, (p) => ({ ...p, aspect_ratio: { type: "enum", values: ["9:16", "1:1"] } }));

  expect(ids(await load(without34))).not.toContain(GROK);
  expect(ids(await load(fakeFetch()))).toContain(GROK);
});

test("a model whose references cannot be left out (input_references.min above 0) is not offered: a candidate portrait sends none", async () => {
  const mustHaveReference = fetchEditing(GROK, (p) => ({ ...p, input_references: { type: "range", min: 1, max: 3 } }));

  expect(ids(await load(mustHaveReference))).not.toContain(GROK);
});

test("a model whose endpoints state no minimum for references is not offered: 'may be zero' is not stated", async () => {
  const noMin = fetchEditing(GROK, (p) => ({ ...p, input_references: { type: "range", max: 3 } }));

  expect(ids(await load(noMin))).not.toContain(GROK);
});

test("one endpoint that fails the portrait request is enough to leave the model out", async () => {
  const inner = fakeFetch();
  const fetch: FetchLike = async (url) => {
    const res = await inner.fetch(url);
    if (!url.endsWith(`/images/models/${GROK}/endpoints`)) return res;
    const body = z.object({ endpoints: z.array(z.record(z.string(), z.unknown())) }).and(z.record(z.string(), z.unknown())).parse(await res.json());
    const second = { ...body.endpoints[0], supported_parameters: { ...z.record(z.string(), z.unknown()).parse(body.endpoints[0]?.supported_parameters), aspect_ratio: { type: "enum", values: ["9:16"] } } };
    return { ok: true, status: 200, json: async () => ({ ...body, endpoints: [...body.endpoints, second] }) };
  };

  expect(ids(await load({ fetch, urls: [] }))).not.toContain(GROK);
});

test("a model with a quality knob lists it and prices each quality with one reference image", async () => {
  const grok = (await load(fakeFetch())).models.find((m) => m.id === GROK);

  expect(grok).toEqual({
    id: GROK,
    name: expect.stringContaining("Grok Imagine Image 2.0"),
    qualities: ["low", "medium"],
    prices: [
      { quality: "low", micros: 50_000 },
      { quality: "medium", micros: 70_000 },
    ],
    tested: true,
  });
});

test("a model without a quality knob has no qualities and one null-quality price at its 1K tier, reference included", async () => {
  const models = (await load(fakeFetch())).models;

  expect(models.find((m) => m.id === "x-ai/grok-imagine-image-quality")).toMatchObject({ qualities: [], prices: [{ quality: null, micros: 60_000 }] });
  expect(models.find((m) => m.id === "bytedance-seed/seedream-5-0-pro")).toMatchObject({ qualities: [], prices: [{ quality: null, micros: 48_000 }] });
  expect(models.find((m) => m.id === "bytedance-seed/seedream-5-0-flash")).toMatchObject({ qualities: [], prices: [{ quality: null, micros: 18_000 }] });
});

test("a model that states a free reference (an explicit input_image row of 0) is listed: seedream-5-0-flash", async () => {
  expect(ids(await load(fakeFetch()))).toContain("bytedance-seed/seedream-5-0-flash");
});

test("the bundled list obeys the same rule: every model of the dated table has a stated reference price", async () => {
  for (const price of FALLBACK_IMAGE.values()) expect(price.inputImageMicros).not.toBeNull();
  expect(ids(await load(fakeFetch({ failList: true }))).sort()).toEqual([...FALLBACK_IMAGE.keys()].sort());
});

test("only the face-hold-tested models are marked tested: the three of the 2026-09-24 spike, named explicitly", async () => {
  const models = (await load(fakeFetch())).models;

  const spiked = [GROK, "bytedance-seed/seedream-5-0-pro", "x-ai/grok-imagine-image-quality"].sort();
  expect(models.filter((m) => m.tested).map((m) => m.id).sort()).toEqual(spiked);
  expect([...TESTED_IMAGE_MODELS].sort()).toEqual(spiked);
});

test("the tested models come first, then the others by name, and the provider prefix is dropped from a name", async () => {
  const models = (await load(fakeFetch())).models;
  const firstUntested = models.findIndex((m) => !m.tested);

  expect(models.slice(0, firstUntested).every((m) => m.tested)).toBe(true);
  expect(models.slice(firstUntested).every((m) => !m.tested)).toBe(true);
  const rest = models.slice(firstUntested).map((m) => m.name);
  expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  expect(models.find((m) => m.id === "bytedance-seed/seedream-5-0-flash")?.name).toBe("Seedream 5.0 Flash");
});

test("the catalogue it builds passes the contract's own schema and is flagged live", async () => {
  const catalogue = await load(fakeFetch());

  expect(catalogue.source).toBe("live");
  expect(ImageModelCatalogue.safeParse(catalogue).success).toBe(true);
});

test("a model whose endpoints cannot be fetched is not listed, the others are", async () => {
  const withFailures = await load(fakeFetch({ failEndpoints: ["qwen/qwen-image-3"], throwEndpoints: ["black-forest-labs/flux-3-image"] }));

  expect(ids(withFailures)).not.toContain("qwen/qwen-image-3");
  expect(ids(withFailures)).not.toContain("black-forest-labs/flux-3-image");
  expect(ids(withFailures)).toContain(GROK);
  expect(withFailures.source).toBe("live");
});

test("a model list that cannot be fetched gives the bundled list: the models of the dated price table, at their dated prices", async () => {
  const catalogue = await load(fakeFetch({ failList: true }));

  expect(catalogue.source).toBe("fallback");
  expect(ids(catalogue).sort()).toEqual([...FALLBACK_IMAGE.keys()].sort());
  expect(catalogue.models.find((m) => m.id === GROK)?.prices).toEqual([
    { quality: "low", micros: 50_000 },
    { quality: "medium", micros: 70_000 },
  ]);
  expect(ImageModelCatalogue.safeParse(catalogue).success).toBe(true);
});

test("when no model of the live list can be priced the bundled list is served instead of an empty one", async () => {
  const everything = ids(await load(fakeFetch()));
  const catalogue = await load(fakeFetch({ failEndpoints: everything }));

  expect(catalogue.source).toBe("fallback");
  expect(catalogue.models.length).toBeGreaterThan(0);
});

test("the bundled list is the same on every call and carries the default model with its two qualities", () => {
  expect(fallbackImageCatalogue()).toEqual(fallbackImageCatalogue());
  expect(fallbackImageCatalogue().models.find((m) => m.id === GROK)?.qualities).toEqual(["low", "medium"]);
});

test("a body that is not a model list gives the bundled list", async () => {
  const fetch: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) });
  const { catalogue } = await loadImageCatalogue({ fetch, baseUrl: BASE });

  expect(catalogue.source).toBe("fallback");
});

test("a live catalogue is complete only when every candidate's endpoints were reached", async () => {
  expect((await loadFull(fakeFetch())).catalogue.complete).toBe(true);
  expect((await loadFull(fakeFetch({ throwEndpoints: [GROK] }))).catalogue.complete).toBe(false);
  expect((await loadFull(fakeFetch({ failList: true }))).catalogue.complete).toBe(false);
});

// ---------- the cache ----------

function cacheWith(loads: CatalogueLoad[]): { cache: ImageCatalogueCache; calls: () => number; advance: (ms: number) => void } {
  let calls = 0;
  let now = 0;
  const cache = new ImageCatalogueCache({
    load: async () => {
      const next = loads[Math.min(calls, loads.length - 1)];
      calls++;
      if (next === undefined) throw new Error("no load");
      return next;
    },
    monotonic: () => now,
  });
  return { cache, calls: () => calls, advance: (ms) => void (now += ms) };
}

const LIVE_COMPLETE: CatalogueLoad = { catalogue: { models: [], source: "live", complete: true } };
const LIVE_PARTIAL: CatalogueLoad = { catalogue: { models: [], source: "live", complete: false } };
const FALLBACK: CatalogueLoad = { catalogue: { models: [], source: "fallback", complete: false } };

test("a complete live catalogue is served from the cache until its refresh time", async () => {
  const { cache, calls, advance } = cacheWith([LIVE_COMPLETE]);
  await cache.get();
  advance(LIVE_CATALOGUE_TTL_MS - 1);
  await cache.get();
  expect(calls()).toBe(1);

  advance(1);
  await cache.get();
  expect(calls()).toBe(2);
});

test("a fallback or partial catalogue is tried again after the short time", async () => {
  for (const first of [FALLBACK, LIVE_PARTIAL]) {
    const { cache, calls, advance } = cacheWith([first]);
    await cache.get();
    advance(FALLBACK_CATALOGUE_TTL_MS - 1);
    await cache.get();
    expect(calls()).toBe(1);

    advance(1);
    await cache.get();
    expect(calls()).toBe(2);
  }
});

test("requests during a load share it", async () => {
  const { cache, calls } = cacheWith([LIVE_COMPLETE]);
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  expect(calls()).toBe(1);
});

test("a load that throws is not cached, and the next call tries again", async () => {
  let calls = 0;
  const cache = new ImageCatalogueCache({
    load: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return LIVE_COMPLETE;
    },
    monotonic: () => 0,
  });
  await expect(cache.get()).rejects.toThrow("boom");
  expect((await cache.get()).source).toBe("live");
  expect(calls).toBe(2);
});

// ---------- review round 1, M3: one bad live entry never spoils the answer ----------

const FLASH = "bytedance-seed/seedream-5-0-flash";
const Listed = z.object({ data: z.array(z.record(z.string(), z.unknown())) });

/** A live list of the fixture's models plus `extra` entries, each a copy of seedream-5-0-flash under its own id and name. */
function fetchWithExtras(extra: readonly { id: string; name?: string }[], opts: { before?: boolean } = {}): Fake {
  const base = Listed.parse(LIST);
  const flash = base.data.find((m) => m.id === FLASH);
  if (flash === undefined) throw new Error("the fixture lacks seedream-5-0-flash");
  const clones = extra.map((e) => ({ ...flash, id: e.id, name: e.name ?? `Clone ${e.id}` }));
  const list = { data: opts.before === true ? [...clones, ...base.data] : [...base.data, ...clones] };
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    if (url === `${BASE}/images/models`) return { ok: true, status: 200, json: async () => list };
    const id = /\/images\/models\/(.+)\/endpoints$/.exec(url)?.[1];
    if (id === undefined) throw new Error(`unexpected GET ${url}`);
    const known = extra.some((e) => e.id === id);
    const body = fixture(endpointsFile(known ? FLASH : id));
    return { ok: true, status: 200, json: async () => (known ? { ...z.record(z.string(), z.unknown()).parse(body), id } : body) };
  };
  return { fetch, urls };
}

test("a listed id that is not a model id is dropped before any GET is made with it", async () => {
  const fake = fetchWithExtras([{ id: "bad id/with space" }, { id: "acme/../escape" }]);
  const catalogue = await load(fake);

  expect(ids(catalogue).some((id) => id.includes("bad") || id.includes(".."))).toBe(false);
  expect(fake.urls.some((u) => u.includes("bad") || u.includes("escape"))).toBe(false);
  expect(ids(catalogue)).toContain(GROK);
});

test("an entry the contract refuses (a name over 120 characters) is dropped, the rest are served and the answer passes the schema", async () => {
  const catalogue = await load(fetchWithExtras([{ id: "acme/long-name", name: "x".repeat(121) }]));

  expect(ids(catalogue)).not.toContain("acme/long-name");
  expect(ids(catalogue)).toContain(GROK);
  expect(ImageModelCatalogue.safeParse(catalogue).success).toBe(true);
});

test("more than 100 priced models are cut to 100, the tested ones first, and the answer passes the schema", async () => {
  // The clones come BEFORE the fixtures in the live list: only "tested first, then cap" keeps the tested models; a cap before the sort drops them.
  const many = Array.from({ length: 105 }, (_, i) => ({ id: `acme/clone-${i}` }));
  const catalogue = await load(fetchWithExtras(many, { before: true }));

  expect(catalogue.models).toHaveLength(100);
  expect(ids(catalogue)).toContain(GROK);
  expect(catalogue.models[0]?.tested).toBe(true);
  expect(ImageModelCatalogue.safeParse(catalogue).success).toBe(true);
});

// ---------- fix round 2: a duplicated id ----------

test("an id listed twice in the live list is served once (the first), and the answer passes the schema", async () => {
  const base = Listed.parse(LIST);
  const grok = base.data.find((m) => m.id === GROK);
  if (grok === undefined) throw new Error("the fixture lacks grok");
  const list = { data: [...base.data, { ...grok, name: "Grok again" }] };
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    if (url === `${BASE}/images/models`) return { ok: true, status: 200, json: async () => list };
    const id = /\/images\/models\/(.+)\/endpoints$/.exec(url)?.[1];
    if (id === undefined) throw new Error(`unexpected GET ${url}`);
    return { ok: true, status: 200, json: async () => fixture(endpointsFile(id)) };
  };
  const { catalogue } = await loadImageCatalogue({ fetch, baseUrl: BASE });

  expect(ids(catalogue).filter((id) => id === GROK)).toHaveLength(1);
  expect(catalogue.models.find((m) => m.id === GROK)?.name).toContain("Grok Imagine Image 2.0");
  expect(ImageModelCatalogue.safeParse(catalogue).success).toBe(true);
  expect(urls.filter((u) => u.endsWith(`${GROK}/endpoints`))).toHaveLength(1);
});
