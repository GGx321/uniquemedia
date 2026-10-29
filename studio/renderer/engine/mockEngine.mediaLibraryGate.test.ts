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

});

