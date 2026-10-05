import { expect, test } from "bun:test";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { montagePickRefusal } from "./photoState";

// 3d.2: «Монтаж из выбранных» takes only photos the engine would take (K11): one photo goes into one video (the
// owner's Q1), so a photo in a video or held by a render is not offered, nor a rejected or ineligible one.

test("a free, eligible scene photo can be picked", () => {
  expect(montagePickRefusal(scenePhoto(1))).toBeNull();
});

test("each photo the engine would refuse says why", () => {
  expect(montagePickRefusal(scenePhoto(1, { rejected: true, eligible: false }))).toBe("Фото отклонено — в монтаж не попадает");
  expect(montagePickRefusal(scenePhoto(1, { used: true, usedIn: ["video-0000001"] }))).toBe("Фото уже в видео: одно фото — одно видео");
  expect(montagePickRefusal(scenePhoto(1, { usedIn: ["video-0000001"] }))).toBe("Фото уже в видео: одно фото — одно видео");
  expect(montagePickRefusal(scenePhoto(1, { reserved: true }))).toBe("Фото занято: в рендере или ждёт незавершённое видео");
  expect(montagePickRefusal(scenePhoto(1, { eligible: false }))).toBe("Это фото не подходит для видео");
});
