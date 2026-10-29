import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { CLIP_REASONS_RU, MOTION_PROBLEMS_RU, OWN_IDEA_MAX, type AvatarSummary, type CommandMessage, type PhotoSummary, type ResponseMessage } from "../../shared/engine";
import { formatUsdTiered } from "../lib/money";
import { MOCK_SUGGEST_PRICE, MOCK_TRANSLATE_PRICE, mockIdeaAnswer, mockSuggestionAnswer, type MockModelReply } from "../engine/mockClipMotions";
import type { MockEngineOptions } from "../engine/mockEngine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, setup, tick } from "../testing";

// 5b.2 part C, S5.WC5 (plan s5b2 §5.3, §6 rows 62–63c, I5.66–I5.68, Q-H = 2; mockups .omc/stage5/design/62-*.html … 63c-*.html and README §S5.WCD): «Предложить движения» and «Своя идея…» in the
// sheet «Оживить фото», against the mock engine, which plays the model's answers and does with them what the engine does (mockClipMotions.ts). Every figure is the engine's: the buttons show the live
// estimate (`clips.estimateSuggest` / `clips.estimateIdea`) and a result its `costMicros`; the window adds nothing.

const NBSP = " ";
const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0001", name: "Nini", masterPhotoId: "photo-nini-master" };
/** Newest first in the gallery: the bold frame is «Фото 1 из 3», the one with no face score «Фото 2», the plain judged one «Фото 3». */
const PLAIN = scenePhoto(1, {}, NINI);
const HIDDEN = scenePhoto(2, {}, NINI);
const BOLD = scenePhoto(3, { category: "nightwear", route: "seedream" }, NINI);
const PHOTOS: PhotoSummary[] = [PLAIN, HIDDEN, BOLD];

/** The buttons' ceilings: the mock's live estimates (held to the engine's by its table test), three decimals, up. */
const SUGGEST_CEILING = `до ${formatUsdTiered(MOCK_SUGGEST_PRICE.worstMicros, "up")}`;
const IDEA_CEILING = `до ${formatUsdTiered(MOCK_TRANSLATE_PRICE.worstMicros, "up")}`;
const MOTION_BUSY = CLIP_REASONS_RU["motion-busy"];
const UNREADABLE: MockModelReply = { kind: "answer", content: "I cannot see the photo", costMicros: 2_000 };
const REFUSED: MockModelReply = { kind: "refused" };
const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");

async function openNini(options: MockEngineOptions = {}) {
  const photos = options.photos ?? PHOTOS;
  const h = setup({ avatars: [{ ...NINI, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos, ...options });
  fireEvent.click(await screen.findByRole("button", { name: "Nini" }));
  await screen.findByRole("heading", { level: 1, name: "Nini" });
  await flush();
  return h;
}
type Harness = Awaited<ReturnType<typeof openNini>>;

const viewer = (): HTMLElement => screen.getByRole("dialog", { name: /^Фото \d+ из \d+$/ });
const sheet = (): HTMLElement => screen.getByRole("dialog", { name: "Оживить фото" });
async function openSheet(n = 3, category = "Дом"): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: `Открыть фото ${n}: ${category}` }));
  await flush();
  fireEvent.click(within(viewer()).getByRole("button", { name: "Оживить" }));
  await flush();
  await flush();
  return sheet();
}
async function reopenSheet(): Promise<HTMLElement> {
  fireEvent.click(within(viewer()).getByRole("button", { name: "Оживить" }));
  await flush();
  await flush();
  return sheet();
}
/** Lets a part C call, the list read after it and the focus that follows settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await flush();
}

const suggestButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: /^(Предложить движения · |Смотрим кадр…)/ });
const ideaToggle = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: "Своя идея…" });
const translateButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: /^(Перевести · |Переводим…)/ });
const goButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: /^Оживить · до/ });
const cancelButton = (s: HTMLElement): HTMLElement => within(s).getByRole("button", { name: "Отмена" });
const field = (s: HTMLElement): HTMLTextAreaElement => within(s).getByRole("textbox", { name: "Своя идея" }) as HTMLTextAreaElement;
/** The field whether its panel is open or not. */
const anyField = (s: HTMLElement): HTMLTextAreaElement => within(s).getByRole("textbox", { name: "Своя идея", hidden: true }) as HTMLTextAreaElement;
const radios = (s: HTMLElement): HTMLInputElement[] => within(within(s).getByRole("radiogroup", { name: "Движение" })).getAllByRole("radio") as HTMLInputElement[];
const rowTexts = (s: HTMLElement): string[] => radios(s).map((r) => plain(r.closest("label")?.textContent));
/** The rows' titles (the bold label, «Своя идея: …» for an own idea), without their English. */
const rowTitles = (s: HTMLElement): string[] => Array.from(s.querySelectorAll<HTMLElement>(".clip-opts > label b")).map((b) => plain(b.textContent));
const checkedRow = (s: HTMLElement): string => plain(radios(s).find((r) => r.checked)?.closest("label")?.textContent);
/** The title of the row a sheet with no choice made is on (FU-CLIP round 2, `defaultMotionOf`): its first suggestion when it lists one, else its first row. */
const defaultTitle = (s: HTMLElement): string => {
  const at = radios(s).findIndex((r) => r.value.startsWith("v-"));
  return rowTitles(s)[at >= 0 ? at : 0] ?? "";
};
const news = (where: "polite" | "alert", root: ParentNode = document): string => plain(root.querySelector(`[data-motion-news="${where}"]`)?.textContent);
const describedText = (el: HTMLElement): string =>
  plain(
    (el.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .filter((id) => id !== "")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" | "),
  );
const focused = (): string => describeElement(document.activeElement);
const isOff = (button: HTMLElement): boolean => button.getAttribute("aria-disabled") === "true";

/** What `clips.options` lists for the photo now: the list on show is the engine's, never a count of the window's. */
async function optionsLabels(h: Harness, photoId = PLAIN.photoId): Promise<string[]> {
  const reply = await h.client.request("clips.options", { avatarId: NINI.avatarId, photoId });
  if (!reply.ok || !reply.result.suitable) throw new Error("expected a suitable photo");
  return reply.result.motions.map((m) => (m.source === "own" ? `Своя идея: ${m.label}` : m.label));
}

async function typeIdea(s: HTMLElement, text: string): Promise<void> {
  if (ideaToggle(s).getAttribute("aria-expanded") !== "true") fireEvent.click(ideaToggle(s));
  await flush();
  fireEvent.change(field(s), { target: { value: text } });
  await flush();
}

async function translate(s: HTMLElement): Promise<void> {
  fireEvent.click(translateButton(s));
  await settle();
}

describe("62: the actions under the list", () => {
  test("«Предложить движения · до $0.035» and «Перевести · до $0.030» show the engine's live estimates; «Своя идея…» opens nothing paid", async () => {
    const h = await openNini();
    const s = await openSheet();
    expect(SUGGEST_CEILING).toBe("до $0.035");
    expect(IDEA_CEILING).toBe("до $0.030");
    expect(suggestButton(s).textContent).toBe(`Предложить движения · ${SUGGEST_CEILING}`);
    expect(isOff(suggestButton(s))).toBe(false);
    expect(callsOf(h.engine, "clips.estimateSuggest")).toHaveLength(1);
    expect(callsOf(h.engine, "clips.estimateIdea")).toHaveLength(1);
    const toggle = ideaToggle(s);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const panel = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(panel?.hidden).toBe(true);
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel?.hidden).toBe(false);
    expect(translateButton(s).textContent).toBe(`Перевести · ${IDEA_CEILING}`);
    expect(callsOf(h.engine, "clips.suggestMotions")).toHaveLength(0);
    expect(callsOf(h.engine, "clips.translateIdea")).toHaveLength(0);
  });

  test("the list is the engine's: the code motions, then the stored suggestions («предложено», English muted), then the stored ideas («Своя идея: …», English muted)", async () => {
    const h = await openNini();
    await h.client.request("clips.suggestMotions", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
    await h.client.request("clips.translateIdea", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, text: "медленно поворачивает голову, прислушиваясь к шуму за окном", acceptedWorstMicros: MOCK_TRANSLATE_PRICE.worstMicros });
    const s = await openSheet();
    const labels = await optionsLabels(h);
    expect(radios(s)).toHaveLength(labels.length);
    const rows = Array.from(s.querySelectorAll<HTMLElement>(".clip-opts > label"));
    expect(rows.map((row) => plain(row.querySelector("b")?.textContent))).toEqual(labels);
    const own = rows.find((row) => row.querySelector("b")?.textContent?.startsWith("Своя идея: ") === true);
    expect(plain(own?.querySelector("b")?.textContent)).toBe("Своя идея: медленно поворачивает голову…");
    expect(own?.querySelector(".clip-en")?.getAttribute("lang")).toBe("en");
    expect(own?.querySelector(".clip-en")?.textContent).toBe("she slowly turns her head toward the window and smiles");
    const suggested = rows.filter((row) => row.querySelector(".mc-tag") !== null);
    expect(suggested.map((row) => row.querySelector(".mc-tag")?.textContent)).toEqual(["предложено", "предложено", "предложено"]);
    expect(suggested.every((row) => row.querySelector(".clip-en[lang='en']") !== null)).toBe(true);
    const code = rows.filter((row) => row.querySelector(".mc-tag") === null && row !== own);
    expect(code.every((row) => row.querySelector(".clip-en") === null)).toBe(true);
    // With no choice made the sheet is on its default: the first suggestion (FU-CLIP round 2), which the engine lists after the code motions.
    expect(checkedRow(s).startsWith(defaultTitle(s))).toBe(true);
    expect(radios(s).find((r) => r.checked)?.value).toBe("v-1");
  });

  test("a price the engine cannot tell leaves the button waiting with «Цену не узнать: … · Повторить», which asks again", async () => {
    const h = await openNini();
    h.engine.failNext("clips.estimateSuggest", { code: "NETWORK", detail: "fetch failed" });
    const s = await openSheet();
    expect(suggestButton(s).textContent).toBe("Предложить движения · до …");
    expect(isOff(suggestButton(s))).toBe(true);
    expect(describedText(suggestButton(s))).toContain("Цену не узнать");
    fireEvent.click(suggestButton(s));
    await flush();
    expect(callsOf(h.engine, "clips.suggestMotions")).toHaveLength(0);
    fireEvent.click(within(s).getByRole("button", { name: "Повторить" }));
    await settle();
    expect(suggestButton(s).textContent).toBe(`Предложить движения · ${SUGGEST_CEILING}`);
  });
});

describe("62a: «Смотрим кадр…» — the guard holds «Оживить» (r2.1 N10)", () => {
  test("the busy button keeps the focus; «Оживить» waits (aria-disabled, not disabled) beside «Подождите: идёт подбор движения или перевод.», a click sends nothing; «Своя идея…» waits too", async () => {
    const h = await openNini();
    const s = await openSheet();
    h.engine.holdMotionCalls(true);
    suggestButton(s).focus();
    fireEvent.click(suggestButton(s));
    await settle();
    const busy = suggestButton(s);
    expect(busy.textContent).toBe("Смотрим кадр…");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(isOff(busy)).toBe(true);
    expect(document.activeElement === busy).toBe(true);
    const go = goButton(s);
    expect(go.hasAttribute("disabled")).toBe(false);
    expect(isOff(go)).toBe(true);
    expect(describedText(go)).toBe(MOTION_BUSY);
    expect(isOff(ideaToggle(s))).toBe(true);
    expect(describedText(ideaToggle(s))).toBe(MOTION_BUSY);
    expect(news("polite", s)).toBe(MOTION_BUSY);
    fireEvent.click(go);
    fireEvent.click(ideaToggle(s));
    await flush();
    expect(callsOf(h.engine, "clips.create")).toHaveLength(0);
    expect(ideaToggle(s).getAttribute("aria-expanded")).toBe("false");
    // A second click on the busy button sends nothing more.
    fireEvent.click(busy);
    await flush();
    expect(callsOf(h.engine, "clips.suggestMotions")).toHaveLength(1);
    expect(callsOf(h.engine, "clips.suggestMotions")[0]?.payload.acceptedWorstMicros).toBe(MOCK_SUGGEST_PRICE.worstMicros);
    h.engine.holdMotionCalls(false);
    await settle();
    expect(isOff(goButton(s))).toBe(false);
    expect(goButton(s).getAttribute("aria-describedby")).toBeNull();
  });

  test("#after-click: the engine refused «Оживить» `motion-busy` (a call this window did not know of) — one alert above the price, the focus on «Отмена», «Оживить» stays", async () => {
    const h = await openNini();
    const s = await openSheet();
    h.engine.failNext("clips.create", { code: "IN_FLIGHT", clipReason: "motion-busy", detail: "a motion is being suggested" });
    fireEvent.click(goButton(s));
    await settle();
    const foot = s.querySelector(".clip-sheet-foot") as HTMLElement;
    expect(plain(foot.querySelector(".notice-info")?.textContent)).toBe(MOTION_BUSY);
    expect(news("alert", s)).toBe(MOTION_BUSY);
    expect(document.activeElement === cancelButton(s)).toBe(true);
    expect(isOff(goButton(s))).toBe(false);
    // Once the call has ended the same click goes through.
    fireEvent.click(goButton(s));
    await settle();
    expect(callsOf(h.engine, "clips.create")).toHaveLength(2);
  });

});

describe("62b: the suggestions are in", () => {
  test("three rows «предложено» with their English after the code motions; the owner's choice stays, the focus on the first; «Предложено 3 движения — оплачено $0.003.» said politely", async () => {
    const h = await openNini();
    const s = await openSheet();
    // The owner's own choice (FU-CLIP round 2: with no choice made, the first suggestion becomes the default once it is in; see below).
    const second = radios(s)[1];
    if (second === undefined) throw new Error("no second row");
    fireEvent.click(second);
    await flush();
    const chosen = checkedRow(s);
    fireEvent.click(suggestButton(s));
    await settle();
    expect(rowTitles(s)).toEqual(await optionsLabels(h));
    const tagged = Array.from(s.querySelectorAll<HTMLElement>(".clip-opts > label")).filter((row) => row.querySelector(".mc-tag") !== null);
    expect(tagged.map((row) => plain(row.querySelector("b")?.textContent))).toEqual(["Движение 1", "Движение 2", "Движение 3"]);
    expect(tagged.map((row) => row.querySelector(".clip-en")?.textContent)).toEqual([
      "she slowly tucks a strand of hair behind her ear",
      "she slowly lifts her chin and smiles softly",
      "she slowly turns toward the window and smiles",
    ]);
    expect(checkedRow(s)).toBe(chosen);
    expect(document.activeElement === tagged[0]?.querySelector("input")).toBe(true);
    const status = plain(s.querySelector(".mc-status")?.textContent);
    expect(status).toBe("Предложено 3 движения — оплачено $0.005.");
    expect(news("polite", s)).toBe(status);
    expect(isOff(goButton(s))).toBe(false);
  });

  test("a suggestion chosen goes to the engine as its `v-` id, never as text", async () => {
    const h = await openNini();
    const s = await openSheet();
    fireEvent.click(suggestButton(s));
    await settle();
    const first = Array.from(s.querySelectorAll<HTMLInputElement>(".clip-opts input")).find((input) => input.value.startsWith("v-"));
    if (first === undefined) throw new Error("no suggestion row");
    fireEvent.click(first);
    fireEvent.click(goButton(s));
    await settle();
    const payload = callsOf(h.engine, "clips.create")[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.motionId).toBe("v-1");
    expect(Object.keys(payload ?? {}).some((key) => /text|idea|label/i.test(key))).toBe(false);
  });
});

describe("FU-CLIP round 2 (MEDIUM-3): a stored suggestion is the sheet's default", () => {
  const priceLine = (s: HTMLElement): string => plain(s.querySelector(".clip-price-line")?.textContent);

  test("a photo with stored suggestions opens on the first of them, and «Оживить» sends its `v-` id", async () => {
    const h = await openNini();
    await h.client.request("clips.suggestMotions", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
    const s = await openSheet();
    expect(radios(s).find((r) => r.checked)?.value).toBe("v-1");
    fireEvent.click(goButton(s));
    await settle();
    expect((callsOf(h.engine, "clips.create")[0]?.payload as Record<string, unknown> | undefined)?.motionId).toBe("v-1");
  });

  test("the price line does not move with the default: the suggestion and a code motion show the same figure", async () => {
    const h = await openNini();
    await h.client.request("clips.suggestMotions", { avatarId: NINI.avatarId, photoId: PLAIN.photoId, acceptedWorstMicros: MOCK_SUGGEST_PRICE.worstMicros });
    const s = await openSheet();
    const price = priceLine(s);
    expect(price).not.toBe("");
    const code = radios(s).find((r) => r.value.startsWith("g-"));
    if (code === undefined) throw new Error("no code motion row");
    fireEvent.click(code);
    await flush();
    expect(priceLine(s)).toBe(price);
  });

});

describe("62c: no suggestion came", () => {
  test("two unusable answers: «Не получилось предложить движения — оплачено $0.004.», warm, said as an alert, the focus on «Отмена», the list as before", async () => {
    const h = await openNini();
    const s = await openSheet();
    const rows = rowTexts(s);
    h.engine.scriptNextMotionReplies([UNREADABLE, UNREADABLE]);
    fireEvent.click(suggestButton(s));
    await settle();
    const notice = s.querySelector(".mc-scroll .notice") as HTMLElement;
    expect(plain(notice.textContent)).toBe("Не получилось предложить движения — оплачено $0.004.");
    expect(notice.classList.contains("notice-warn")).toBe(true);
    expect(notice.getAttribute("role")).toBeNull();
    expect(news("alert", s)).toBe("Не получилось предложить движения — оплачено $0.004.");
    expect(document.activeElement === cancelButton(s)).toBe(true);
    expect(rowTexts(s)).toEqual(rows);
  });

  test("#free: nothing came and nothing was billed — «Не получилось предложить движения — бесплатно.», calm, said politely", async () => {
    const h = await openNini();
    const s = await openSheet();
    h.engine.scriptNextMotionReplies([REFUSED]);
    fireEvent.click(suggestButton(s));
    await settle();
    const notice = s.querySelector(".mc-scroll .notice") as HTMLElement;
    expect(plain(notice.textContent)).toBe("Не получилось предложить движения — бесплатно.");
    expect(notice.classList.contains("notice-info")).toBe(true);
    expect(news("polite", s)).toBe("Не получилось предложить движения — бесплатно.");
  });

  test("a paid answer, then a moderation refusal: the call cost money, so it says «оплачено $0.002», never «бесплатно»", async () => {
    const h = await openNini();
    const s = await openSheet();
    h.engine.scriptNextMotionReplies([UNREADABLE, REFUSED]);
    fireEvent.click(suggestButton(s));
    await settle();
    expect(plain(s.querySelector(".mc-scroll .notice")?.textContent)).toBe("Не получилось предложить движения — оплачено $0.002.");
  });

});

describe("62d: the frame's notes", () => {
});

describe("63: «Своя идея…» — the field", () => {
  test("the contract's rules: a tab or a ZWJ emoji is «Уберите из идеи служебные символы.»; digits and signs alone want words; a plain emoji with words is fine", async () => {
    const h = await openNini();
    const s = await openSheet();
    await typeIdea(s, "медленно поворачивает голову\tк окну");
    const bad = within(s).getByText("Уберите из идеи служебные символы.");
    expect(field(s).getAttribute("aria-invalid")).toBe("true");
    expect(describedText(field(s))).toContain("Уберите из идеи служебные символы.");
    expect(isOff(translateButton(s))).toBe(true);
    expect(translateButton(s).getAttribute("aria-describedby")).toBe(bad.id);
    await typeIdea(s, "улыбается 👩‍🦰");
    expect(within(s).getByText("Уберите из идеи служебные символы.")).toBeDefined();
    await typeIdea(s, "123 !!!");
    expect(within(s).getByText("Опишите движение словами.")).toBeDefined();
    expect(isOff(translateButton(s))).toBe(true);
    await typeIdea(s, "улыбается 🙂");
    expect(within(s).queryByText("Опишите движение словами.") == null).toBe(true);
    expect(field(s).getAttribute("aria-invalid")).toBe("false");
    expect(isOff(translateButton(s))).toBe(false);
    fireEvent.click(translateButton(s));
    await settle();
    expect(callsOf(h.engine, "clips.translateIdea")[0]?.payload.text).toBe("улыбается 🙂");
  });

});

describe("63a: the idea translated", () => {
  test("the field closes; «Своя идея: медленно поворачивает голову…» with its English is chosen and focused; «Идея переведена — оплачено $0.001.»; the clip sends its `o-` id only", async () => {
    const h = await openNini();
    const s = await openSheet();
    const idea = "медленно поворачивает голову, прислушиваясь к шуму за окном";
    await typeIdea(s, `  ${idea}  `);
    h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly turns her head toward the window")]);
    await translate(s);
    expect(callsOf(h.engine, "clips.translateIdea")[0]?.payload).toEqual({ avatarId: NINI.avatarId, photoId: PLAIN.photoId, text: idea, acceptedWorstMicros: MOCK_TRANSLATE_PRICE.worstMicros });
    expect(anyField(s).closest("section")?.hidden).toBe(true);
    expect(ideaToggle(s).getAttribute("aria-expanded")).toBe("false");
    expect(anyField(s).value).toBe("");
    expect(checkedRow(s)).toBe("Своя идея: медленно поворачивает голову…she slowly turns her head toward the window");
    expect(document.activeElement === radios(s).find((r) => r.checked)).toBe(true);
    expect(plain(s.querySelector(".mc-status")?.textContent)).toBe("Идея переведена — оплачено $0.001.");
    expect(news("polite", s)).toBe("Идея переведена — оплачено $0.001.");
    fireEvent.click(goButton(s));
    await settle();
    const payload = callsOf(h.engine, "clips.create")[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.motionId).toBe("o-1");
    expect(JSON.stringify(payload)).not.toContain("медленно");
  });

  test("#bold (Q-H = 2): on a frame of «Смелая» an idea that takes clothing off is accepted like any other — chosen, no mark, no new warning", async () => {
    const h = await openNini();
    const s = await openSheet(1, "Ночнушки и бельё");
    await typeIdea(s, "медленно снимает халат с плеч");
    h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly lets her robe fall from her shoulders")]);
    await translate(s);
    expect(checkedRow(s)).toBe("Своя идея: медленно снимает халат с плечshe slowly lets her robe fall from her shoulders");
    expect(s.querySelector(".mc-refusal") == null).toBe(true);
    expect(radios(s).find((r) => r.checked)?.closest("label")?.querySelector(".mc-tag") == null).toBe(true);
    expect(within(s).getByText("Для кадров «Смелой» запасной модели нет: если Kling откажет, клип не снимется — отказ бесплатный.")).toBeDefined();
    expect(callsOf(h.engine, "clips.translateIdea")).toHaveLength(1);
  });
});

describe("63b, 63c: the idea refused", () => {
  test("63b: ONE reason, the first in the contract's order, and «За перевод оплачено $0.002.»; the field keeps his text, is invalid and described by it, takes the focus; nothing else says it (no double read)", async () => {
    const h = await openNini();
    const s = await openSheet();
    await typeIdea(s, "отпивает чай, а потом поправляет волосы");
    const twice = "she slowly sips her tea and then tucks her hair behind her ear";
    h.engine.scriptNextMotionReplies([mockIdeaAnswer(twice, 1_000), mockIdeaAnswer(twice, 1_000)]);
    await translate(s);
    const refusal = s.querySelector(".mc-refusal") as HTMLElement;
    // The answer broke two rules (two-movements, too-long): the first in the display order is said, alone (README «Один текст на отказ»).
    expect(Array.from(refusal.querySelectorAll("p")).map((p) => plain(p.textContent))).toEqual([plain(MOTION_PROBLEMS_RU["two-movements"])]);
    expect(plain(refusal.querySelector(".mc-paid")?.textContent)).toBe("За перевод оплачено $0.002.");
    expect(refusal.getAttribute("role")).toBeNull();
    expect(refusal.classList.contains("mc-refusal-warn")).toBe(true);
    const f = field(s);
    expect(f.value).toBe("отпивает чай, а потом поправляет волосы");
    expect(f.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(f)).toContain("Так не получится: два движения сразу — оставьте одно.");
    expect(document.activeElement === f).toBe(true);
    expect(news("alert", s)).not.toContain("Так не получится");
    expect(news("polite", s)).not.toContain("Так не получится");
    // An edit ends it.
    fireEvent.change(f, { target: { value: "отпивает чай" } });
    await flush();
    expect(s.querySelector(".mc-refusal") == null).toBe(true);
    expect(field(s).getAttribute("aria-invalid")).toBe("false");
  });

  test("each code says its own text, one per refusal: not-small, phone; not-motion over staging, content over not-small", async () => {
    const cases: [string, string[]][] = [
      ["she quickly spins around", [MOTION_PROBLEMS_RU["not-small"]]],
      ["she slowly lowers her phone and looks at the mirror", [MOTION_PROBLEMS_RU.phone]],
      ["the camera slowly zooms in on her face", [MOTION_PROBLEMS_RU["not-motion"]]],
      ["she smiles like a schoolgirl", [MOTION_PROBLEMS_RU.content]],
    ];
    const h = await openNini();
    const s = await openSheet();
    // S5.WC2c round 2 (M1): a number on its own in his words is the age guard's, refused before the call, so each idea is told apart by a word, not a number.
    for (const [i, [english, texts]] of cases.entries()) {
      await typeIdea(s, `идея ${["первая", "вторая", "третья", "четвёртая"][i] ?? "ещё одна"}`);
      h.engine.scriptNextMotionReplies([mockIdeaAnswer(english), mockIdeaAnswer(english)]);
      await translate(s);
      expect(Array.from(s.querySelectorAll(".mc-refusal p")).map((p) => plain(p.textContent))).toEqual(texts.map(plain));
    }
  });

  test("S5.WC2c round 2 (M1): an idea whose own words name an age is refused before the call: the content text, «Перевод — бесплатно.», nothing sent", async () => {
    const h = await openNini();
    const s = await openSheet();
    await typeIdea(s, "медленно снимает халат, ей шестнадцать");
    h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly takes off her robe")]);
    await translate(s);
    const refusal = s.querySelector(".mc-refusal") as HTMLElement;
    expect(Array.from(refusal.querySelectorAll("p")).map((p) => plain(p.textContent))).toEqual([plain(MOTION_PROBLEMS_RU.content)]);
    expect(plain(refusal.querySelector(".mc-paid")?.textContent)).toBe("Перевод — бесплатно.");
    expect(h.engine.peekMotions().lines).toHaveLength(0);
    expect(rowTexts(s).some((row) => row.startsWith("Своя идея"))).toBe(false);
  });

  test("S5.WC2c: an idea the age guard refuses only in its English is refused at once with the content text, after one paid attempt", async () => {
    const h = await openNini();
    const s = await openSheet();
    await typeIdea(s, "медленно снимает халат");
    h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly takes off her robe, aged sixteen"), mockIdeaAnswer("she slowly takes off her robe")]);
    await translate(s);
    const refusal = s.querySelector(".mc-refusal") as HTMLElement;
    expect(Array.from(refusal.querySelectorAll("p")).map((p) => plain(p.textContent))).toEqual([plain(MOTION_PROBLEMS_RU.content)]);
    expect(plain(refusal.querySelector(".mc-paid")?.textContent)).toBe("За перевод оплачено $0.001.");
    expect(h.engine.peekMotions().lines.filter((line) => line.attemptId.includes(":idea#"))).toHaveLength(1);
    expect(rowTexts(s).some((row) => row.startsWith("Своя идея"))).toBe(false);
  });

  test("`none`: two unusable answers «Не получилось перевести идею — оплачено $0.004.»; the model refused «… — бесплатно»; paid then refused is paid", async () => {
    const h = await openNini();
    const s = await openSheet();
    await typeIdea(s, "медленно поворачивает голову к окну и улыбается");
    h.engine.scriptNextMotionReplies([UNREADABLE, UNREADABLE]);
    await translate(s);
    let refusal = s.querySelector(".mc-refusal") as HTMLElement;
    expect(plain(refusal.textContent)).toBe("Не получилось перевести идею — оплачено $0.004.");
    expect(refusal.classList.contains("mc-refusal-warn")).toBe(true);
    expect(document.activeElement === field(s)).toBe(true);
    h.engine.scriptNextMotionReplies([REFUSED]);
    await translate(s);
    refusal = s.querySelector(".mc-refusal") as HTMLElement;
    expect(plain(refusal.textContent)).toBe("Не получилось перевести идею — бесплатно.");
    expect(refusal.classList.contains("mc-refusal-info")).toBe(true);
    h.engine.scriptNextMotionReplies([UNREADABLE, REFUSED]);
    await translate(s);
    expect(plain(s.querySelector(".mc-refusal")?.textContent)).toBe("Не получилось перевести идею — оплачено $0.002.");
  });
});

describe("the paid buttons' refusals, as the other paid buttons'", () => {
  test("PRICE_CHANGED: the fresh price on the button and «Цена изменилась: теперь не больше $0.035. Подтвердите ещё раз.» once; a new click sends the fresh price", async () => {
    const h = await openNini();
    const s = await openSheet();
    h.engine.failNext("clips.suggestMotions", { code: "PRICE_CHANGED", detail: "the worst case moved" });
    fireEvent.click(suggestButton(s));
    await settle();
    const text = `Цена изменилась: теперь не больше ${formatUsdTiered(MOCK_SUGGEST_PRICE.worstMicros, "up")}. Подтвердите ещё раз.`;
    expect(plain(s.querySelector(".mc-scroll .notice")?.textContent)).toBe(text);
    expect(news("alert", s)).toBe(text);
    expect(suggestButton(s).textContent).toBe(`Предложить движения · ${SUGGEST_CEILING}`);
    expect(callsOf(h.engine, "clips.estimateSuggest")).toHaveLength(2);
    fireEvent.click(suggestButton(s));
    await settle();
    expect(callsOf(h.engine, "clips.suggestMotions").map((c) => c.payload.acceptedWorstMicros)).toEqual([MOCK_SUGGEST_PRICE.worstMicros, MOCK_SUGGEST_PRICE.worstMicros]);
    expect(plain(s.querySelector(".mc-status")?.textContent)).toBe("Предложено 3 движения — оплачено $0.005.");
  });

  test("PRICE_CHANGED on «Перевести» is said in the field's card; BUDGET_EXCEEDED says the month", async () => {
    const h = await openNini();
    const s = await openSheet();
    await typeIdea(s, "медленно поворачивает голову");
    h.engine.failNext("clips.translateIdea", { code: "PRICE_CHANGED", detail: "the worst case moved" });
    await translate(s);
    const card = field(s).closest("section") as HTMLElement;
    expect(plain(card.querySelector(".notice")?.textContent)).toBe(`Цена изменилась: теперь не больше ${formatUsdTiered(MOCK_TRANSLATE_PRICE.worstMicros, "up")}. Подтвердите ещё раз.`);
    h.engine.failNext("clips.translateIdea", { code: "BUDGET_EXCEEDED", detail: "no room" });
    await translate(s);
    expect(plain(card.querySelector(".notice")?.textContent)).toBe("Месячный бюджет исчерпан. Увеличьте его в Настройках или дождитесь следующего месяца.");
    expect(news("alert", s)).toBe("Месячный бюджет исчерпан. Увеличьте его в Настройках или дождитесь следующего месяца.");
  });

});

describe("the guard the other way: a clip holds the clip money unit (`clip-busy`)", () => {
});

/** The writer's answer with these labels and texts (the mock's own helper numbers its labels). */
function labelled(pairs: readonly [string, string][]): MockModelReply {
  const content = JSON.stringify({ motions: pairs.map(([label_ru, text_en]) => ({ label_ru, text_en })), frame: { capture: "unknown", phoneVisible: false, faceVisible: true } });
  return { kind: "answer", content, costMicros: 3_400 };
}

describe("round 2: where the focus goes after 63a, and a chosen row that leaves the list", () => {
});

describe("round 2: L1 and 63a together", () => {
});

describe("round 3: a list read again that fails or drops the chosen row", () => {
});

describe("round 2: the smaller points", () => {
  test("L8: an estimate of nothing says «бесплатно», never «до $0.000»", async () => {
    const h = await openNini();
    const original = h.engine.request.bind(h.engine);
    // The mock prices a suggestion at the engine's figure; a test stands a free one in its answer.
    h.engine.request = async (command: CommandMessage): Promise<ResponseMessage> => {
      const reply = await original(command);
      if (!reply.ok || reply.type !== "clips.estimateSuggest") return reply;
      return { ...reply, result: { ...reply.result, expectedMicros: 0, worstMicros: 0 } };
    };
    const s = await openSheet();
    expect(suggestButton(s).textContent).toBe("Предложить движения · бесплатно");
  });

  test("a rejection that cost nothing says «Перевод — бесплатно.»", async () => {
    const h = await openNini();
    const s = await openSheet();
    // S5.WC2c: an idea the age guard refuses (an undressing one is no refusal any more), final at once.
    await typeIdea(s, "медленно снимает халат, ей шестнадцать");
    h.engine.scriptNextMotionReplies([mockIdeaAnswer("she slowly takes off her robe, aged sixteen", 0)]);
    await translate(s);
    expect(plain(s.querySelector(".mc-refusal .mc-paid")?.textContent)).toBe("Перевод — бесплатно.");
  });
});

describe("a11y: the live regions are in the sheet from the start", () => {
});

describe("S5.WC5b: the review's follow-ups in sheet 38", () => {
  const ready = (name: RegExp | string): HTMLElement => screen.getByRole("article", { name });
  const clipsTab = (): HTMLElement => screen.getByRole("tab", { name: /^Клипы/ });

  test("`unknown-motion` after «Оживить»: the list is read again, the drop is said ONCE (the alert) and the first row chosen, «Движение больше недоступно — выберите другое.» on show", async () => {
    const h = await openNini();
    const s = await openSheet();
    fireEvent.click(suggestButton(s));
    await settle();
    fireEvent.click(radios(s).find((r) => r.value === "v-1") as HTMLElement);
    await flush();
    // The store lost the suggestion behind the window's back: the engine no longer knows `v-1`.
    h.engine.tamperMotionStore(PLAIN.photoId, (store) => {
      store.items = store.items.filter((item) => item.id !== "v-1");
    });
    const before = callsOf(h.engine, "clips.options").length;
    const politeBefore = news("polite", s);
    const alerts: string[] = [];
    const watch = new MutationObserver(() => {
      const now = news("alert");
      if (now !== "" && alerts.at(-1) !== now) alerts.push(now);
    });
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    fireEvent.click(goButton(s));
    await settle();
    watch.disconnect();
    if (news("alert") !== "" && alerts.at(-1) !== news("alert")) alerts.push(news("alert"));
    expect(callsOf(h.engine, "clips.options").length).toBe(before + 1);
    expect(radios(s).some((r) => r.value === "v-1")).toBe(false);
    // The sheet's default takes the dropped row's place: the first suggestion still listed (FU-CLIP round 2), else the first row.
    const first = defaultTitle(s);
    expect(checkedRow(s).startsWith(first)).toBe(true);
    // Round 2 (L-3): one message — the drop line, in the alert; the polite region keeps what it said before the click.
    expect(alerts).toEqual([`Движение «Движение 1» больше не в списке — выбрано «${first}».`]);
    expect(news("polite", s)).toBe(politeBefore);
    expect(plain(s.querySelector(".clip-sheet-foot .notice")?.textContent)).toBe("Движение больше недоступно — выберите другое.");
    expect(plain(s.textContent)).not.toContain("откройте «Оживить» заново");
  });

});

describe("S5.WC5b round 2 (M-1): the sheet reopened before the answer came says it when it comes", () => {
  /** «Предложить» or «Перевести» sent, «Отмена», and the sheet opened again while the call still runs. */
  async function reopenedWhileRunning(h: Harness, send: (s: HTMLElement) => Promise<void>): Promise<HTMLElement> {
    const s = await openSheet();
    h.engine.holdMotionCalls(true);
    await send(s);
    await settle();
    fireEvent.click(cancelButton(s));
    await flush();
    return reopenSheet();
  }

  test("a paid `none`: the open sheet shows and alerts it; the next opening says nothing again", async () => {
    const h = await openNini();
    h.engine.scriptNextMotionReplies([UNREADABLE, UNREADABLE]);
    let s = await reopenedWhileRunning(h, async (sheetNow) => {
      fireEvent.click(suggestButton(sheetNow));
    });
    expect(suggestButton(s).textContent).toBe("Смотрим кадр…");
    h.engine.holdMotionCalls(false);
    await settle();
    expect(plain(s.querySelector(".mc-scroll .notice")?.textContent)).toBe("Не получилось предложить движения — оплачено $0.004.");
    expect(news("alert", s)).toBe("Не получилось предложить движения — оплачено $0.004.");
    fireEvent.click(cancelButton(s));
    await flush();
    s = await reopenSheet();
    expect(s.querySelector(".mc-scroll .notice") == null).toBe(true);
    expect(news("alert", s)).toBe("");
  });

  test("an `ok`: the open sheet shows its line and the new rows; the next opening says nothing again", async () => {
    const h = await openNini();
    let s = await reopenedWhileRunning(h, async (sheetNow) => {
      fireEvent.click(suggestButton(sheetNow));
    });
    h.engine.holdMotionCalls(false);
    await settle();
    const line = plain(s.querySelector(".mc-status")?.textContent);
    expect(line.startsWith("Предложено 3 движения — оплачено $")).toBe(true);
    expect(news("polite", s)).toBe(line);
    expect(rowTitles(s)).toEqual(await optionsLabels(h));
    fireEvent.click(cancelButton(s));
    await flush();
    s = await reopenSheet();
    expect(s.querySelector(".mc-status") == null).toBe(true);
  });

  test("a rejected idea: the open sheet opens the card with its reason and its cost, the focus in the field; the next opening says nothing again", async () => {
    const h = await openNini();
    const twice = "she slowly sips her tea and then tucks her hair behind her ear";
    h.engine.scriptNextMotionReplies([mockIdeaAnswer(twice, 1_000), mockIdeaAnswer(twice, 1_000)]);
    let s = await reopenedWhileRunning(h, async (sheetNow) => {
      await typeIdea(sheetNow, "отпивает чай, а потом поправляет волосы");
      fireEvent.click(translateButton(sheetNow));
    });
    h.engine.holdMotionCalls(false);
    await settle();
    expect(ideaToggle(s).getAttribute("aria-expanded")).toBe("true");
    const refusal = s.querySelector(".mc-refusal") as HTMLElement;
    expect(plain(refusal.querySelector("p")?.textContent)).toBe(plain(MOTION_PROBLEMS_RU["two-movements"]));
    expect(plain(refusal.querySelector(".mc-paid")?.textContent)).toBe("За перевод оплачено $0.002.");
    expect(document.activeElement === field(s)).toBe(true);
    fireEvent.click(cancelButton(s));
    await flush();
    s = await reopenSheet();
    expect(s.querySelector(".mc-refusal") == null).toBe(true);
    expect(ideaToggle(s).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("S5.WC5b round 2: one announcement per answer", () => {
});
