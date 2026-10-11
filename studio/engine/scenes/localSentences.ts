import { templateSentence, type TemplateSlot } from "../../shared/scenes/template";

// 5a.2 (S5.6c1, plan s5a2 r1.5 §5.4): the seam between the code template and the LLM writer, as the three callers use it (a run, a scene set's compose
// and «Дописать», a planned review write). `localSentences` renders every slot the caller hands it ONCE, in the order given, and answers `local(slot)`:
// the template's sentence, or null when the template cannot write it (m2: the place AND the moment are found by name in today's banks, or the custom
// adapter finds the slot in the plan's or set's category snapshot). A null slot goes to the model at its chunk's reserved ids. Never a throw.
//
// Rendering up front, in plan order, makes the text independent of what a resume has already journaled: the dedup (I5.24, an equal sentence in the run
// is redrawn) sees only earlier slots of the same list, so a slot's text is the same on every job.

export interface LocalSentencesInput<S extends TemplateSlot & { slotIndex: number }> {
  /** Every slot the template may be asked about, in the order that fixes the dedup. */
  slots: readonly S[];
  /** The slot's draw key: `slotKeyOf(runId, attemptIdBase)` for a run, `${sceneSetId}:${sceneId}:${k}` for a scene set's k-th write. */
  keyOf: (slot: S) => string;
  /** The custom categories the plan or the set holds a snapshot of. */
  snapshots?: readonly { ref: string }[] | undefined;
}

export function localSentences<S extends TemplateSlot & { slotIndex: number }>(input: LocalSentencesInput<S>): (slot: S) => string | null {
  const rendered = new Map<number, string>();
  const seen = new Set<string>();
  for (const slot of input.slots) {
    const text = templateSentence(slot, { key: input.keyOf(slot), snapshots: input.snapshots, seen });
    if (text === null) continue;
    rendered.set(slot.slotIndex, text);
    seen.add(text);
  }
  return (slot) => rendered.get(slot.slotIndex) ?? null;
}
