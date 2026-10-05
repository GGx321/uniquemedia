import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Montage } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { useWorld } from "../videos/testing/kit";
import { MAX_DRAFT_FILES_READ } from "./store";
import { montageRig } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `montages.list` over more draft files than one listing reads: the sound drafts it did not look at are «not listed», never «unreadable».

const world = useWorld();

describe("montages.list: more draft files than the listing reads", () => {
  test("the files left unread are reported as notListedTotal, and skippedTotal stays the files that cannot be read", async () => {
    const w = world();
    const r = montageRig(w);
    const dir = join(w.libraryRoot, "avatars", w.avatar.id, "montages");
    await mkdir(dir, { recursive: true });
    const name = (n: number): string => `montage-${String(n).padStart(6, "0")}`;
    const text = (n: number): string => JSON.stringify({ schemaVersion: 1, ...Montage.parse({ montageId: name(n), name: null, spec: defaultSpec(w.avatar.id, [], 3), updatedAt: "2026-09-30T10:00:00.000Z" }) });
    await Promise.all(Array.from({ length: MAX_DRAFT_FILES_READ + 2 }, (_, n) => writeFile(join(dir, `${name(n)}.json`), text(n))));

    const answer = await r.service.list(w.avatar.id);

    expect(answer.skippedTotal).toBe(0);
    expect(answer.notListedTotal).toBe(2);
  });

  test("with every file read there is no notListedTotal at all: the answer is what it always was", async () => {
    const w = world();
    const r = montageRig(w);

    expect(await r.service.list(w.avatar.id)).toEqual({ items: [], total: 0, skippedTotal: 0 });
  });
});
