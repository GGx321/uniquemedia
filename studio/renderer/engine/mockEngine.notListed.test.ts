import { expect, test } from "bun:test";
import { makeMock, MIA, unwrap } from "./mockEngine.testkit";

// `montages.list`'s notListedTotal: draft files a listing did not read; absent when there are none, as the engine answers.

test("montages.list reports the files it did not read as notListedTotal, apart from skippedTotal", async () => {
  const mock = makeMock();
  await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [] }));
  mock.engine.setNotListedDrafts(4);

  const listed = await unwrap(mock.client.request("montages.list", {}));

  expect(listed).toMatchObject({ total: 1, skippedTotal: 0, notListedTotal: 4 });
});

test("montages.list leaves notListedTotal out when every file was read", async () => {
  const mock = makeMock();

  const listed = await unwrap(mock.client.request("montages.list", {}));

  expect("notListedTotal" in listed).toBe(false);
});
