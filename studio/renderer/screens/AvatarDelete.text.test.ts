import { describe, expect, test } from "bun:test";
import type { AvatarDeletePreview } from "../../shared/engine";
import { filesText, goesText, keptText } from "./AvatarDelete";

// The words of the «Удалить аватар» confirmation and of what is said after it. A no-break space is read as a space.
const plain = (text: string | null): string => (text ?? "").replace(/ /g, " ");
const preview = (over: Partial<AvatarDeletePreview> = {}): AvatarDeletePreview => ({ avatarId: "avatar-0001", photos: 0, candidates: 0, drafts: 0, videos: 0, videoFilesFound: 0, videoFilesUnchecked: 0, ...over });

describe("goesText", () => {
  test("lists what there is except the videos, which have a line of their own", () => {
    expect(plain(goesText(preview({ photos: 22, drafts: 2, videos: 3, videoFilesFound: 3 })))).toBe("Уйдут в Корзину: 22 фото, 2 черновика монтажа.");
  });

  test("an avatar with nothing else says so", () => {
    expect(plain(goesText(preview()))).toBe("Кроме самого аватара, у него пока ничего нет.");
  });
});

describe("filesText", () => {
  test("is absent when there is no video", () => {
    expect(filesText(preview())).toBeNull();
  });

  test("says how many videos and how many of their files go, in one line", () => {
    expect(plain(filesText(preview({ videos: 3, videoFilesFound: 3 })))).toBe("Видео: 3. Файлов в «Готовые видео» найдено 3 из 3 — они уйдут в Корзину.");
  });

  test("files that are not in the folder now stay where they are", () => {
    expect(plain(filesText(preview({ videos: 3, videoFilesFound: 1 })))).toContain("2 там нет — они останутся как есть.");
  });

  test("files that could not be checked in time are told apart from the ones that are not there", () => {
    const text = plain(filesText(preview({ videos: 4, videoFilesFound: 1, videoFilesUnchecked: 2 })));

    expect(text).toContain("найдено 1 из 4");
    expect(text).toContain("2 не успели проверить — они тоже останутся");
    expect(text).toContain("1 там нет — они останутся как есть.");
  });
});

describe("keptText", () => {
  test("names the folder the files stayed in", () => {
    expect(plain(keptText({ kept: 2, unchecked: 0, folder: "Mia" }))).toBe("2 видео не удалось переместить в Корзину — они остались в папке «Готовые видео/Mia».");
  });

  test("tells the unchecked ones apart", () => {
    const text = plain(keptText({ kept: 0, unchecked: 3, folder: "Mia" }));

    expect(text).toContain("3 видео не успели проверить");
    expect(text).not.toContain("не удалось переместить");
  });

  test("tells both when both happened", () => {
    const text = plain(keptText({ kept: 1, unchecked: 2, folder: null }));

    expect(text).toContain("1 видео не удалось переместить в Корзину");
    expect(text).toContain("2 видео не успели проверить");
    expect(text).toContain("«Готовые видео»");
  });
});
