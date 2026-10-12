// 5a.3 (S5.9b1, plan s5a3 §5.2 and §6.1): what the «Смелая» level is allowed that the global lists refuse. The lists in shared/scenes/words.ts and
// shared/engine/ageText.ts stay exactly as they are, for every other level and every other path (montage captions included); the exemptions live only
// here, and only the content-line module (contentLine.ts) and, from S5.9b2, the two «Смелая» bank schemas import them.

/**
 * Garment names the youth rule would refuse (its `bab(?:y|ies)\w*` matches «babydoll») but that are lingerie, not a youth word: answer (b) of the owner.
 * The name only: «baby» alone, «baby doll» in two words and «baby blue» stay refused, and the plural «babydolls» is the same garment.
 */
export const BOLD_EXEMPT_YOUTH: readonly string[] = ["babydoll"];
