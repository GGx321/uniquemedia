import { describe, expect, test } from "bun:test";
import { OWN_IDEA_FALLBACK_LABEL, ownIdeaLabel } from "../../shared/engine";
import { makeBatchMock } from "./mockEngine.clipBatch.testkit";
import {
  AVATAR,
  BOLD,
  GOOD_TEXTS,
  PLAIN,
  UNDRESS,
  create,
  endOf,
  errorOf,
  idea,
  listClips,
  makeClipMock,
  optionsOf,
  phasesOf,
  runUntilEnd,
  suggest,
  suggestion,
  translate,
  unwrap,
  type ClipMock,
} from "./mockEngine.clipMotions.testkit";

// Stage 5, 5b.2, S5.WC4 (plan s5b2 §5.3 «The store», I5.67; r2.1 L2): the photo's motion store in the mock, `clips.options` listing it, and `clips.create` / `clips.createBatch` resolving `v-` and `o-` ids from it, as the
// engine does (engine.clipMotions.test.ts, clips/motionStore.test.ts). The owner's idea is never in the store: the label and the English text are.

async function filled(): Promise<ClipMock> {
  const m = makeClipMock();
  m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 3))]);
  await unwrap(suggest(m));
  m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(3, 5))]);
  await unwrap(suggest(m));
  for (const [i, text] of [GOOD_TEXTS[0], GOOD_TEXTS[1], GOOD_TEXTS[2]].entries()) {
    m.engine.scriptNextMotionReplies([idea(text)]);
    await unwrap(translate(m, ["первая идея", "вторая идея", "третья идея"][i] ?? ""));
  }
  return m;
}

describe("the store", () => {
  test("a good answer is stored under the photo: v-1..v-3 with their labels, and the reading", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 3))]);
    expect(await unwrap(suggest(m))).toMatchObject({
      outcome: "ok",
      reading: { notes: [] },
      motions: [
        { id: "v-1", source: "vision", label: "Движение 1", text: GOOD_TEXTS[0] },
        { id: "v-2", source: "vision", label: "Движение 2", text: GOOD_TEXTS[1] },
        { id: "v-3", source: "vision", label: "Движение 3", text: GOOD_TEXTS[2] },
      ],
    });
    expect(m.engine.peekMotions().stores[PLAIN]).toMatchObject({ next: { vision: 4, own: 1 }, reading: { notes: [] } });
  });

  test("a second suggestion continues the ids and replaces the reading", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 2))]);
    await unwrap(suggest(m));
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(2, 3), 3_400, { capture: "unknown", phoneVisible: true, faceVisible: true })]);
    expect(await unwrap(suggest(m))).toMatchObject({ outcome: "ok", motions: [{ id: "v-3" }], reading: { notes: ["second-phone"] } });
    expect(m.engine.peekMotions().stores[PLAIN]?.items.map((i) => i.id)).toEqual(["v-1", "v-2", "v-3"]);
    expect(m.engine.peekMotions().stores[PLAIN]?.reading).toEqual({ notes: ["second-phone"] });
  });

  test("the store keeps twelve (FIFO) and an id is never reused", async () => {
    const m = makeClipMock();
    for (let n = 0; n < 5; n++) {
      m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 3))]);
      await unwrap(suggest(m));
    }
    const store = m.engine.peekMotions().stores[PLAIN];
    expect(store?.items).toHaveLength(12);
    expect(store?.items[0]?.id).toBe("v-4");
    expect(store?.next.vision).toBe(16);
  });

  test("the store is `motions-full` once every v- id is issued: VALIDATION, free, nothing sent; the other source is not full", async () => {
    const m = makeClipMock();
    m.engine.tamperMotionStore(PLAIN, (store) => {
      store.next.vision = 1000;
    });
    expect(await errorOf(suggest(m))).toMatchObject({ code: "VALIDATION", clipReason: "motions-full" });
    expect(m.engine.peekMotions().lines).toEqual([]);
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[0])]);
    expect(await unwrap(translate(m))).toMatchObject({ outcome: "ok" });
  });

  test("a source with fewer ids left than drafts keeps the first ones, and an id past the maximum is never issued", async () => {
    const m = makeClipMock();
    m.engine.tamperMotionStore(PLAIN, (store) => {
      store.next.vision = 999;
    });
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 3))]);
    const result = await unwrap(suggest(m));
    expect(result.outcome === "ok" && result.motions.map((x) => x.id)).toEqual(["v-999"]);
    expect(await errorOf(suggest(m))).toMatchObject({ clipReason: "motions-full" });
  });

  test("the store keeps the label and the English text of an idea, never the idea", async () => {
    const m = makeClipMock();
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[0])]);
    await unwrap(translate(m, "медленно поворачивает голову к окну и улыбается, CANARY-9c41"));
    const store = m.engine.peekMotions().stores[PLAIN];
    expect(JSON.stringify(store)).not.toContain("CANARY");
    expect(store?.items).toEqual([{ id: "o-1", source: "own", label: ownIdeaLabel("медленно поворачивает голову к окну и улыбается, CANARY-9c41"), text: GOOD_TEXTS[0] }]);
    expect(store?.next).toEqual({ vision: 1, own: 2 });
  });

  test("a changed photo file empties the store: the ids start again", async () => {
    const m = await filled();
    m.engine.changeClipPhotoFile(PLAIN);
    expect((await optionsOf(m)).motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
    m.engine.scriptNextMotionReplies([suggestion(GOOD_TEXTS.slice(0, 1))]);
    expect(await unwrap(suggest(m))).toMatchObject({ motions: [{ id: "v-1" }] });
  });
});

describe("clips.options lists the stored motions", () => {
  test("the newest three suggestions and the newest two ideas after the code motions, with the reading, and makes no chat call", async () => {
    const m = await filled();
    const linesBefore = m.engine.peekMotions().lines.length;
    const listed = await optionsOf(m);
    expect(listed.motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath", "v-3", "v-4", "v-5", "o-2", "o-3"]);
    expect(listed.reading).toEqual({ notes: [] });
    expect(m.engine.peekMotions().lines).toHaveLength(linesBefore);
  });

  test("checks the stored items again: one edited into a text that no longer passes is not listed, and an older one takes its place", async () => {
    const m = await filled();
    m.engine.tamperMotionStore(PLAIN, (store) => {
      for (const item of store.items) if (item.id === "v-5") item.text = UNDRESS;
    });
    const listed = await optionsOf(m);
    expect(listed.motions.filter((x) => x.source === "vision").map((x) => x.id)).toEqual(["v-2", "v-3", "v-4"]);
  });

  test("a frame of «Смелая» lists an undressing idea; an ordinary frame does not", async () => {
    const m = makeClipMock({ clips: { boldClips: "kling-only" } });
    m.engine.scriptNextMotionReplies([idea(UNDRESS)]);
    await unwrap(translate(m, "снимает халат", BOLD));
    expect((await optionsOf(m, BOLD)).motions.map((x) => x.id)).toContain("o-1");
    m.engine.tamperMotionStore(PLAIN, (store) => {
      store.items.push({ id: "o-1", source: "own", label: "снимает халат", text: UNDRESS });
      store.next.own = 2;
    });
    expect((await optionsOf(m, PLAIN)).motions.map((x) => x.id)).not.toContain("o-1");
  });

  test("a photo with nothing stored lists the code motions and no reading", async () => {
    const m = makeClipMock();
    const listed = await optionsOf(m);
    expect(listed.motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
    expect(listed.reading).toBeUndefined();
  });

  test("clips.batchOptions lists them too, per photo", async () => {
    const m = await filled();
    const batch = await unwrap(m.client.request("clips.batchOptions", { avatarId: AVATAR, photoIds: [PLAIN] }));
    const [item] = batch.items;
    expect(item?.suitable && item.motions.map((x) => x.id)).toEqual(["g-blink", "g-tilt", "g-breath", "v-3", "v-4", "v-5", "o-2", "o-3"]);
  });
});

describe("clips.create and clips.createBatch resolve v- and o- ids", () => {
  test("a v- id makes the clip with that text; its record says `vision`, with the label", async () => {
    const m = await filled();
    const { jobId } = await unwrap(create(m, { motionId: "v-4" }));
    runUntilEnd(m, jobId);
    expect((await listClips(m))[0]?.motion).toEqual({ source: "vision", label: "Движение 1", text: GOOD_TEXTS[3] });
  });

  test("an o- id makes the clip with that text; its record says `own`, with the label cut from his words", async () => {
    const m = await filled();
    const { jobId } = await unwrap(create(m, { motionId: "o-3" }));
    runUntilEnd(m, jobId);
    expect((await listClips(m))[0]?.motion).toEqual({ source: "own", label: "третья идея", text: GOOD_TEXTS[2] });
  });

  test("an id the photo does not offer is `unknown-motion`, free: one beyond the newest three, one never issued, one from an empty store", async () => {
    const m = await filled();
    for (const motionId of ["v-1", "v-9", "o-1", "o-9"]) {
      const refused = await errorOf(create(m, { motionId }));
      expect([motionId, refused.code, refused.clipReason]).toEqual([motionId, "VALIDATION", "unknown-motion"]);
    }
    const empty = makeClipMock();
    for (const motionId of ["v-1", "o-1"]) expect((await errorOf(create(empty, { motionId }))).clipReason).toBe("unknown-motion");
    expect(m.engine.peekClips().attempts).toEqual([]);
  });

  test("clips.createBatch resolves them the same way, and an unknown id is that item's own `unknown-motion`", async () => {
    const m = makeBatchMock(1);
    m.engine.scriptNextMotionReplies([idea(GOOD_TEXTS[1])]);
    await unwrap(m.client.request("clips.translateIdea", { avatarId: AVATAR, photoId: m.photoIds[0] ?? "", text: "вторая идея", acceptedWorstMicros: 1_000_000 }));
    const payload = (motionId: string) => ({ avatarId: AVATAR, items: [{ photoId: m.photoIds[0] ?? "", motionId }], quality: "std" as const, seconds: 5 as const, fallback: "auto" as const, acceptedWorstMicros: 850_000 });
    expect(await errorOf(m.client.request("clips.createBatch", payload("o-2")))).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion", path: ["items", 0] });
    const made = await unwrap(m.client.request("clips.createBatch", payload("o-1")));
    for (let i = 0; i < 6_000 && endOf(m.events, made.jobIds[0] ?? "") === undefined; i++) if (!m.scheduler.next()) break;
    const clips = await unwrap(m.client.request("clips.list", { avatarId: AVATAR }));
    expect(clips.clips[0]?.motion).toMatchObject({ source: "own", label: "вторая идея", text: GOOD_TEXTS[1] });
    void phasesOf;
  });
});

describe("an own idea that takes clothing off goes to Kling alone (Q-H = 2)", () => {
  async function undressWorld(clips: NonNullable<Parameters<typeof makeClipMock>[0]>["clips"]) {
    const m = makeClipMock({ clips });
    m.engine.scriptNextMotionReplies([idea(UNDRESS)]);
    expect(await unwrap(translate(m, "снимает халат", BOLD))).toMatchObject({ outcome: "ok" });
    return m;
  }

  test("with BOLD_CLIPS `with-fallback` and an automatic fallback the clip runs on Kling alone: the request says fallback none, the sheet's Kling-only figure is enough", async () => {
    const m = await undressWorld({ boldClips: "with-fallback" });
    const { jobId } = await unwrap(create(m, { photoId: BOLD, motionId: "o-1", fallback: "auto", acceptedWorstMicros: 504_000 }));
    runUntilEnd(m, jobId);
    expect(endOf(m.events, jobId)?.type).toBe("job.done");
    expect(m.engine.peekClips().posts).toEqual(["kling"]);
    expect((await listClips(m))[0]?.request.fallback).toBe("none");
  });

  test("a Grok clip for it is refused `grok-not-offered` even in mode `offer`", async () => {
    const m = await undressWorld({ boldClips: "with-fallback", mode: "offer" });
    expect(await errorOf(create(m, { photoId: BOLD, motionId: "o-1", model: "grok", fallback: "none", acceptedWorstMicros: 850_000 }))).toMatchObject({ code: "VALIDATION", clipReason: "grok-not-offered" });
  });

  test("a batch of it is priced by the member's share, Kling alone, and runs", async () => {
    const m = await undressWorld({ boldClips: "with-fallback" });
    const made = await unwrap(m.client.request("clips.createBatch", { avatarId: AVATAR, items: [{ photoId: BOLD, motionId: "o-1" }], quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 504_000 }));
    expect(made.jobIds).toHaveLength(1);
  });

  test("a vision-written or code motion on an ordinary photo is unchanged: the fallback still follows the photo", async () => {
    const m = makeClipMock({ clips: { mode: "offer" } });
    const { jobId } = await unwrap(create(m, { model: "grok", fallback: "none", acceptedWorstMicros: 850_000 }));
    runUntilEnd(m, jobId);
    expect(endOf(m.events, jobId)).toBeDefined();
  });
});

describe("the journal and a restart (I5.67)", () => {
  test("an own motion's `requested` line has no label; a vision one keeps it", async () => {
    const m = await filled();
    const own = await unwrap(create(m, { motionId: "o-3" }));
    for (let i = 0; i < 400 && (m.engine.peekClips().journals[own.jobId] ?? []).length === 0; i++) if (!m.scheduler.next()) break;
    const line = (m.engine.peekClips().journals[own.jobId] ?? [])[0];
    expect(line).toMatchObject({ type: "requested", motion: { source: "own", text: GOOD_TEXTS[2] } });
    expect(line && "motion" in line && "label" in line.motion).toBe(false);
  });

  test("a restart in the middle of an own clip recovers its label from the photo's store", async () => {
    const m = await filled();
    const own = await unwrap(create(m, { motionId: "o-3" }));
    for (let i = 0; i < 400 && !phasesOf(m.events, own.jobId).includes("submitting"); i++) if (!m.scheduler.next()) break;
    m.engine.restart();
    m.scheduler.runAll();
    expect((await listClips(m))[0]).toMatchObject({ clipId: own.jobId, recovered: true, motion: { source: "own", label: "третья идея", text: GOOD_TEXTS[2] } });
  });

  test("when the store no longer holds the idea the recovered label is «Своя идея»", async () => {
    const m = await filled();
    const own = await unwrap(create(m, { motionId: "o-3" }));
    for (let i = 0; i < 400 && !phasesOf(m.events, own.jobId).includes("submitting"); i++) if (!m.scheduler.next()) break;
    m.engine.changeClipPhotoFile(PLAIN);
    m.engine.restart();
    m.scheduler.runAll();
    expect((await listClips(m))[0]?.motion).toEqual({ source: "own", label: OWN_IDEA_FALLBACK_LABEL, text: GOOD_TEXTS[2] });
  });

  test("when the photo is no longer the avatar's the recovered label is «Своя идея» too: the engine asks the photo before the store", async () => {
    const m = await filled();
    const own = await unwrap(create(m, { motionId: "o-3" }));
    for (let i = 0; i < 400 && !phasesOf(m.events, own.jobId).includes("submitting"); i++) if (!m.scheduler.next()) break;
    m.engine.removeClipPhoto(PLAIN);
    m.engine.restart();
    m.scheduler.runAll();
    expect((await listClips(m))[0]?.motion).toEqual({ source: "own", label: OWN_IDEA_FALLBACK_LABEL, text: GOOD_TEXTS[2] });
  });

  test("the store survives a restart", async () => {
    const m = await filled();
    m.engine.restart();
    expect((await optionsOf(m)).motions.map((x) => x.id)).toContain("v-5");
  });
});
