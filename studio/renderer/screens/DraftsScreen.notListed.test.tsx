import { expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";

// Draft files a listing did not read (more than it reads) are not «не читаются»: the engine counts them as `notListedTotal`, and the screen says they are not shown.

test("draft files that were not read are said to be not shown, never to be unreadable", async () => {
  const { client, engine } = await studio();
  await makeDraft(client, MIA.avatarId, []);
  engine.setNotListedDrafts(2);

  await openDrafts();

  expect(await screen.findByText("ещё 2 черновика не показаны: файлов слишком много")).toBeDefined();
  expect(screen.queryByText(/не читаются/) === null).toBe(true);
});

test("unreadable draft files keep their own line", async () => {
  const { client, engine } = await studio();
  await makeDraft(client, MIA.avatarId, []);
  engine.setSkippedDrafts(3);

  await openDrafts();

  expect(await screen.findByText("ещё 3 черновика не читаются")).toBeDefined();
});
