import { describe, expect, test } from "bun:test";
import { deleteButtonText, deleteDialogText, deleteFailedText, plainDoneText, rejectDoneText } from "./deleteVideo";

// S4.9c: the words of «Удалить видео» (README decision 11; LaunchStates «Удалить видео»; plan §8.5 and §17 Q4): two ways, the published video's dialog on
// «и отклонить фото» (Q4 = A, pending the owner), the button repeating the choice, and a refusal that promises nothing it cannot know.

const NBSP = " ";

describe("the dialog", () => {
  test("a published video: «и отклонить фото» chosen, and why (ApDeletePublished)", () => {
    const text = deleteDialogText("видео 3 · Mia", true, 6);
    expect(text.title).toBe("Удалить видео 3 · Mia?");
    expect(text.lead).toBe("Файл в «Готовых видео» тоже удалится. Видео уже опубликовано — поэтому выбрано «отклонить фото»: эти кадры не уйдут в новый ролик.");
    expect(text.preselect).toBe("reject");
    expect(text.reject).toEqual({ title: "Удалить видео и отклонить фото", sub: `6${NBSP}фото уйдут в «Отклонённые» — автопилот их больше не возьмёт.` });
    expect(text.plain).toEqual({ title: "Только удалить видео", sub: `6${NBSP}фото снова станут свободными — из них может собраться новое видео.` });
  });

  test("a video not published: the plain delete chosen, as before; one photo is said in the singular", () => {
    const text = deleteDialogText("видео 9 · Sofia", false, 1);
    expect(text.preselect).toBe("plain");
    expect(text.lead).toBe("Файл в «Готовых видео» тоже удалится.");
    expect(text.reject.sub).toBe(`1${NBSP}фото уйдёт в «Отклонённые» — автопилот его больше не возьмёт.`);
    expect(text.plain.sub).toBe(`1${NBSP}фото снова станет свободным — из него может собраться новое видео.`);
    expect(deleteDialogText("видео 2", false, 21).reject.sub).toStartWith(`21${NBSP}фото уйдёт`);
  });

  test("the button repeats the choice", () => {
    expect([deleteButtonText("reject"), deleteButtonText("plain")]).toEqual(["Удалить и отклонить фото", "Удалить видео"]);
  });
});

describe("what a delete did, and why one did not go", () => {
  test("done: the photos rejected by the answer's count, or freed", () => {
    expect(rejectDoneText("видео 3 · Mia", { fileDeleted: true, fileState: "present", rejectedPhotoIds: ["p1", "p2", "p3", "p4", "p5", "p6"] })).toBe(`Видео 3 · Mia удалено, 6${NBSP}фото отклонены.`);
    expect(rejectDoneText("видео 3 · Mia", { fileDeleted: false, fileState: "missing", rejectedPhotoIds: ["p1"] })).toBe(`Видео 3 · Mia: запись удалена, файла в «Готовых видео» уже не было; 1${NBSP}фото отклонено.`);
    expect(plainDoneText("видео 4 · Mia", 2)).toBe(`Видео 4 · Mia удалено, 2${NBSP}фото снова свободны.`);
  });

  // Fix round 1: a delete that timed out reads as EXPORT_UNAVAILABLE (`not-writable`) while its work may go on, and NOT_FOUND may mean it is gone already —
  // so no failure says «не удалено»: the delete did not come back confirmed, and the lists, read again, show what stands.
  test("the export folder did not answer (or a timeout that reads the same): nothing is promised, the video or the photos", () => {
    const failed = deleteFailedText({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" }, true);
    expect(failed.title).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(failed.text).toBe(
      "Папка «Готовые видео» не ответила. В эту папку нельзя записывать. Фото, что успели уйти в «Отклонённые», там и останутся. Если видео осталось в списке, удалите его ещё раз, когда папка вернётся.",
    );
    expect(deleteFailedText({ code: "EXPORT_UNAVAILABLE" }, false).text).toBe("Папка «Готовые видео» не ответила. Если видео осталось в списке, удалите его ещё раз, когда папка вернётся.");
  });

  test("NOT_FOUND: the video is no longer in the library; any other refusal says the engine's reason; none says «не удалено»", () => {
    expect(deleteFailedText({ code: "NOT_FOUND", detail: "no video" }, false)).toEqual({ title: "Удаление не подтвердилось — списки прочитаны заново", text: "Этого видео уже нет в библиотеке." });
    const failed = deleteFailedText({ code: "INTERNAL", detail: "disk" }, true);
    expect(failed.title).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(failed.text).toContain("Фото, что успели уйти в «Отклонённые», там и останутся.");
    expect(failed.text).toEndWith("Если видео осталось в списке, удалите его ещё раз.");
    expect(deleteFailedText({ code: "INTERNAL", detail: "disk" }, false).text).not.toContain("Отклонённые");
    for (const code of ["EXPORT_UNAVAILABLE", "NOT_FOUND", "INTERNAL"] as const) expect(`${deleteFailedText({ code }, true).title} ${deleteFailedText({ code }, true).text}`).not.toContain("не удалено");
  });
});
