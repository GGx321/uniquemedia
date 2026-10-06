import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ImageModelCatalogue } from "../shared/engine";
import { fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, ok, OFFLINE, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// `settings.imageModels`: the catalogue Settings offers, answered by the engine
// (it owns the network). The bodies are real, saved 2026-10-05 (see
// imageModels/catalogue.test.ts); everything but the model list and the
// endpoints answers as an offline network.

const dir = useEngineDir("studio-engine-image-models-");

function fixture(name: string): object {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./imageModels/fixtures/${name}`, import.meta.url)), "utf8"));
}

function network(live: boolean) {
  const route = async (call: FetchCall): Promise<Reply> => {
    if (!live) return OFFLINE;
    if (call.url.endsWith("/images/models")) return { status: 200, body: fixture("images-models.json") };
    const match = /\/images\/models\/(.+)\/endpoints$/.exec(call.url);
    if (match?.[1] !== undefined) return { status: 200, body: fixture(`endpoints/${match[1].replace("/", "_")}.json`) };
    return OFFLINE;
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return { fetch: net.fetch, calls: net.calls, listCalls: () => net.calls.filter((c) => c.url.endsWith("/images/models")) };
}

async function catalogueOf(live: boolean) {
  const net = network(live);
  const { engine } = await startEngine(dir(), { deps: { fetch: net.fetch } });
  const response = ok(await engine.handle(command("settings.imageModels")));
  return { net, engine, response };
}

describe("settings.imageModels", () => {
  test("answers the live catalogue, priced per photo with one reference, in the contract's shape", async () => {
    const { response } = await catalogueOf(true);
    expect(response.type).toBe("settings.imageModels");
    const parsed = ImageModelCatalogue.parse(response.result);

    expect(parsed.source).toBe("live");
    expect(parsed.models.map((m) => m.id)).toContain("bytedance-seed/seedream-5-0-flash");
    expect(parsed.models.find((m) => m.id === "x-ai/grok-imagine-image-2.0")).toMatchObject({ qualities: ["low", "medium"], tested: true });
  });

  test("a second ask is answered from the cache: the model list is fetched once", async () => {
    const { net, engine } = await catalogueOf(true);
    ok(await engine.handle(command("settings.imageModels")));

    expect(net.listCalls()).toHaveLength(1);
  });

  test("offline, answers the bundled list flagged as a fallback: the three models of the dated price table", async () => {
    const { response } = await catalogueOf(false);
    const parsed = ImageModelCatalogue.parse(response.result);

    expect(parsed.source).toBe("fallback");
    expect(parsed.models.map((m) => m.id).sort()).toEqual(["bytedance-seed/seedream-5-0-pro", "x-ai/grok-imagine-image-2.0", "x-ai/grok-imagine-image-quality"]);
  });

  test("spends nothing: only free GETs leave, no POST", async () => {
    const { net } = await catalogueOf(true);

    expect(net.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
