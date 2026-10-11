import type { ParityRig } from "./rigs";
import type { Scenario } from "./scenarios";
import { Normalizer, Transcript } from "./transcript";

/**
 * Plays a scenario against a rig and returns its transcript. The seeded ids are named first, in seed order, so `photo#3` is the
 * third seeded photo in both engines whatever the order the scenario meets them in. Whatever the scenario did, the rig is
 * stopped after it, so no render outlives it.
 */
export async function play(rig: ParityRig, scenario: Scenario): Promise<string[]> {
  const norm = new Normalizer();
  const { world } = rig;
  norm.register("avatar", world.avatarId);
  norm.register("avatar", world.otherAvatarId);
  norm.register("avatar", world.archivedAvatarId);
  // Stage 5 (S5.3c): a rig with `portraits` seeds three imported avatars, named after the three above.
  if (world.portraitAvatars !== undefined) for (const id of [world.portraitAvatars.imported, world.portraitAvatars.pending, world.portraitAvatars.crowded]) norm.register("avatar", id);
  for (const id of [...world.photoIds, ...world.otherPhotoIds]) norm.register("photo", id);
  const transcript = new Transcript(rig, norm);
  try {
    await scenario.run(transcript, world, rig.control);
  } finally {
    await rig.stop();
  }
  transcript.finish();
  return transcript.lines();
}
