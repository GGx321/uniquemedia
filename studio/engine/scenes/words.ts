// Review round 1 (MEDIUM): the revealing-outfit guard (Stage 2's fixed decision: no revealing outfits until the owner's provider is connected) was
// duplicated in pools.ts and writer.ts. S5.9b1: the list now lives in shared/scenes/words.ts, next to the content-line module that reads it at every
// level; this module re-exports it, so pools.ts, writer.ts and poolGen.ts keep their import and no second copy exists.

export { hasRevealingWord, REVEALING_WORDS, revealingWordsIn } from "../../shared/scenes/words";
