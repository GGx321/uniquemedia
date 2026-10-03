import { describe, expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
import { draftOf, makeMock, PHOTO_IDS, renderDraft, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// 3e.3: the mock answers the export-folder commands as main and the engine do together (`settings.setExportPath` through main's
// dialog, `settings.exportDisplay`, `export.check`). The dialog itself is the mock's own control, `pickExportFolderNext`;
// the parity suite (studio/engine/parity) plays the same stories against the real engine.

const [P1, P2, P3, P4] = PHOTO_IDS as [string, string, string, string, string, string];
const FIRST = "/Users/studio/Studio/export";
const REELS = "/Users/studio/Reels";

/** Two finished videos, made in the folder the mock starts with. */
async function withTwoVideos(): Promise<Mock> {
  const mock = makeMock();
  for (const photos of [[P1, P2], [P3, P4]]) {
    const draft = await draftOf(mock, photos);
    await renderDraft(mock, draft.montageId);
    mock.scheduler.runAll();
  }
  return mock;
}

const setExportPath = (mock: Mock) => mock.client.request("settings.setExportPath", {});
const eventsSince = (mock: Mock, mark: number): EventMessage[] => mock.events.slice(mark);

async function fileStates(mock: Mock): Promise<string[]> {
  const { videos } = await unwrap(mock.client.request("videos.list", { avatarId: "avatar-mia-0001" }));
  return videos.map((v) => v.fileState);
}

describe("settings.setExportPath", () => {
  test("a cancelled dialog answers picked: false and changes nothing: no setting, no event", async () => {
    const mock = makeMock();
    mock.engine.pickExportFolderNext(null);
    const mark = mock.events.length;

    expect(await unwrap(setExportPath(mock))).toEqual({ picked: false });

    expect(eventsSince(mock, mark)).toEqual([]);
    expect((await unwrap(mock.client.request("settings.get", {}))).exportPath).toBe(FIRST);
  });

  test("a picked folder becomes the export folder, with an identity of its own and every video so far elsewhere", async () => {
    const mock = await withTwoVideos();
    mock.engine.pickExportFolderNext({ path: REELS });

    const answer = await unwrap(setExportPath(mock));

    expect(answer).toMatchObject({ picked: true, resolved: 0, elsewhere: 2, settings: { exportPath: REELS } });
    expect((await unwrap(mock.client.request("settings.get", {}))).exportPath).toBe(REELS);
  });

  test("the videos read elsewhere while the other folder is the export folder", async () => {
    const mock = await withTwoVideos();
    expect(await fileStates(mock)).toEqual(["present", "present"]);
    mock.engine.pickExportFolderNext({ path: REELS });

    await setExportPath(mock);

    expect(await fileStates(mock)).toEqual(["elsewhere", "elsewhere"]);
  });

  test("choosing the first folder again gets every video back: the same identity, all resolved, present again", async () => {
    const mock = await withTwoVideos();
    mock.engine.pickExportFolderNext({ path: REELS });
    const away = await unwrap(setExportPath(mock));
    mock.engine.pickExportFolderNext({ path: FIRST });

    const back = await unwrap(setExportPath(mock));

    expect(back).toMatchObject({ picked: true, resolved: 2, elsewhere: 0 });
    expect(away.picked && back.picked && back.rootId !== away.rootId).toBe(true);
    expect(await fileStates(mock)).toEqual(["present", "present"]);
  });

  test("a folder the owner moved (same marker, new place) resolves every video", async () => {
    const mock = await withTwoVideos();
    mock.engine.pickExportFolderNext({ path: "/Users/studio/Archive/Готовые видео", movedFrom: FIRST });

    const answer = await unwrap(setExportPath(mock));

    expect(answer).toMatchObject({ picked: true, resolved: 2, elsewhere: 0 });
    expect(await fileStates(mock)).toEqual(["present", "present"]);
  });

  test("with no video there is nothing to resolve or to leave behind", async () => {
    const mock = makeMock();
    mock.engine.pickExportFolderNext({ path: REELS });

    expect(await unwrap(setExportPath(mock))).toMatchObject({ picked: true, resolved: 0, elsewhere: 0 });
  });

  test("counts are whole unless the pick says some records could not be read", async () => {
    const mock = await withTwoVideos();
    mock.engine.pickExportFolderNext({ path: REELS });
    expect(await unwrap(setExportPath(mock))).toMatchObject({ picked: true, incomplete: false });

    mock.engine.pickExportFolderNext({ path: FIRST, incomplete: true });
    expect(await unwrap(setExportPath(mock))).toMatchObject({ picked: true, incomplete: true });
  });

  test("an unscripted dialog picks a new folder, so the dev mock shows the switch", async () => {
    const mock = await withTwoVideos();

    const answer = await unwrap(setExportPath(mock));

    expect(answer).toMatchObject({ picked: true, resolved: 0, elsewhere: 2 });
    expect(answer.picked && answer.settings.exportPath).not.toBe(FIRST);
  });

  test("a pick is used once: the next dialog is unscripted again", async () => {
    const mock = makeMock();
    mock.engine.pickExportFolderNext(null);
    await setExportPath(mock);

    expect((await unwrap(setExportPath(mock))).picked).toBe(true);
  });

  test("announces the new settings; and the folder's status first when it changed, as the engine's check after settings.update does", async () => {
    const mock = makeMock();
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await mock.client.request("export.check", {});
    const mark = mock.events.length;
    mock.engine.setExportDisk({ status: "ok" });
    mock.engine.pickExportFolderNext({ path: REELS });

    await setExportPath(mock);

    expect(typesOf(eventsSince(mock, mark))).toEqual(["export.status", "settings.changed"]);
  });

  test("is refused with IN_FLIGHT while a render is queued or running, and nothing changes", async () => {
    const mock = makeMock();
    const draft = await draftOf(mock, [P1, P2]);
    await renderDraft(mock, draft.montageId);
    mock.engine.pickExportFolderNext({ path: REELS });

    const reply = await setExportPath(mock);

    expect(reply).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect((await unwrap(mock.client.request("settings.get", {}))).exportPath).toBe(FIRST);
  });
});

describe("settings.setExportPath: a folder that cannot be the export folder", () => {
  test.each(["missing", "not-a-directory", "not-writable", "overlaps-library", "newer-marker"] as const)("%s is refused with its reason, and nothing changes", async (reason) => {
    const mock = await withTwoVideos();
    mock.engine.pickExportFolderNext({ path: REELS, refuse: reason });
    const mark = mock.events.length;

    const reply = await setExportPath(mock);

    expect(reply).toMatchObject({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: reason } });
    expect(eventsSince(mock, mark)).toEqual([]);
    expect((await unwrap(mock.client.request("settings.get", {}))).exportPath).toBe(FIRST);
    expect(await fileStates(mock)).toEqual(["present", "present"]);
  });

  test("a damaged marker is invalid-marker-with-records once a video exists: the text that never advises deleting the file", async () => {
    const mock = await withTwoVideos();
    mock.engine.pickExportFolderNext({ path: REELS, refuse: "invalid-marker" });

    expect(await setExportPath(mock)).toMatchObject({ ok: false, error: { exportReason: "invalid-marker-with-records" } });
  });

  test("and plain invalid-marker while the library has no video", async () => {
    const mock = makeMock();
    mock.engine.pickExportFolderNext({ path: REELS, refuse: "invalid-marker" });

    expect(await setExportPath(mock)).toMatchObject({ ok: false, error: { exportReason: "invalid-marker" } });
  });
});

describe("settings.exportDisplay", () => {
  test("shows the export folder with the home folder as «~»", async () => {
    const mock = makeMock();

    expect(await unwrap(mock.client.request("settings.exportDisplay", {}))).toEqual({ display: "~/Studio/export" });
  });

  test("follows a pick, and leaves a folder outside home as it is", async () => {
    const mock = makeMock();
    mock.engine.pickExportFolderNext({ path: REELS });
    await setExportPath(mock);
    expect(await unwrap(mock.client.request("settings.exportDisplay", {}))).toEqual({ display: "~/Reels" });

    mock.engine.pickExportFolderNext({ path: "/Volumes/Reels" });
    await setExportPath(mock);
    expect(await unwrap(mock.client.request("settings.exportDisplay", {}))).toEqual({ display: "/Volumes/Reels" });
  });
});

describe("export.check", () => {
  test("a folder that is fine answers ok and says nothing", async () => {
    const mock = makeMock();
    const mark = mock.events.length;

    expect(await unwrap(mock.client.request("export.check", {}))).toEqual({ exportStatus: { status: "ok" } });
    expect(eventsSince(mock, mark)).toEqual([]);
  });

  test("an unplugged folder answers unavailable and tells the windows once; a replugged one, ok", async () => {
    const mock = makeMock();
    const mark = mock.events.length;
    mock.engine.setExportDisk({ status: "unavailable", reason: "missing" });

    expect(await unwrap(mock.client.request("export.check", {}))).toEqual({ exportStatus: { status: "unavailable", reason: "missing" } });
    await mock.client.request("export.check", {});
    mock.engine.setExportDisk({ status: "ok" });
    expect(await unwrap(mock.client.request("export.check", {}))).toEqual({ exportStatus: { status: "ok" } });

    const statuses = eventsSince(mock, mark).flatMap((e) => (e.type === "export.status" ? [e.payload.exportStatus] : []));
    expect(statuses).toEqual([{ status: "unavailable", reason: "missing" }, { status: "ok" }]);
  });

  test("a damaged marker reads invalid-marker-with-records once a video exists", async () => {
    const mock = await withTwoVideos();
    mock.engine.setExportDisk({ status: "unavailable", reason: "invalid-marker" });

    expect(await unwrap(mock.client.request("export.check", {}))).toEqual({ exportStatus: { status: "unavailable", reason: "invalid-marker-with-records" } });
  });
});
