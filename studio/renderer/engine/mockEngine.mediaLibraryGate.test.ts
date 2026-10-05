import { describe, expect, test } from "bun:test";
import { makeMock } from "./mockEngine.testkit";

// The mock answers the own-media commands as the engine does (`withLibrary`): no library is LIBRARY_UNAVAILABLE, and while a library switch is being
// surveyed the command waits for it with IN_FLIGHT (the switch is checked first, as the engine checks it).

describe("media.list and media.delete without a library", () => {
  test("media.list answers LIBRARY_UNAVAILABLE", async () => {
    const mock = makeMock();
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("media.list", {});

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("media.delete answers LIBRARY_UNAVAILABLE, before it looks for the media", async () => {
    const mock = makeMock();
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("media.delete", { mediaId: "media-00000404" });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("with a library open they answer as before", async () => {
    const mock = makeMock();

    expect(await mock.client.request("media.list", {})).toMatchObject({ ok: true, result: { total: 0 } });
    expect(await mock.client.request("media.delete", { mediaId: "media-00000404" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("media.list and media.delete while a library switch is surveyed", () => {
  test("both wait with IN_FLIGHT, which the engine checks before the library itself", async () => {
    const mock = makeMock();
    mock.engine.setLibrarySwitching(true);
    mock.engine.setLibraryAvailable(false);

    expect(await mock.client.request("media.list", {})).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(await mock.client.request("media.delete", { mediaId: "media-00000404" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("once the survey ends they answer again", async () => {
    const mock = makeMock();
    mock.engine.setLibrarySwitching(true);
    mock.engine.setLibrarySwitching(false);

    expect(await mock.client.request("media.list", {})).toMatchObject({ ok: true });
  });
});
