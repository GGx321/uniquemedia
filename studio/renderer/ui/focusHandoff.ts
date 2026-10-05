// Where the keyboard's focus goes when what held it goes away or is hidden (review r1 LOW-3, r2 LOW-2 and LOW-4): a notice closed by its own
// button, a dock card folded behind a newer one, the dock's «Свернуть список» once one card is left. The first enabled button of the nearest
// notice shown beside it (the next one, else the one before), else the screen's title; never the body, from which the next Tab would start at
// the top of the window.

/** The notices shown in `node`'s area (its dock, or the page), nearest after it first, then the ones before it, nearest first. */
function neighbours(node: HTMLElement): HTMLElement[] {
  const area = node.closest(".ed-dock, .content");
  const notices = area === null ? [] : [...area.querySelectorAll<HTMLElement>(".notice")].filter((n) => n !== node && !node.contains(n));
  const after = notices.filter((n) => (node.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const before = notices.filter((n) => (node.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).reverse();
  return [...after, ...before];
}

function target(candidates: readonly HTMLElement[]): HTMLElement | null {
  const button = candidates
    .filter((n) => n.isConnected && !n.hidden)
    .map((n) => n.querySelector<HTMLElement>("button:not([disabled])"))
    .find((b) => b !== null);
  return button ?? document.querySelector<HTMLElement>(".content .screen-title");
}

/**
 * `node` (which holds the focus) is going: once the commit that removes it is done (and has drawn whatever takes its place, such as the next
 * card of a dock's stack), the focus moves on, unless something took it meanwhile (a new screen's title).
 */
export function handOffFocusAfterRemoval(node: HTMLElement): void {
  const candidates = neighbours(node);
  queueMicrotask(() => {
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    target(candidates)?.focus();
  });
}

/** `node` (which holds the focus) is hidden but stays: the focus moves on at once, to a neighbour that is shown. */
export function handOffFocusFromHidden(node: HTMLElement): void {
  target(neighbours(node))?.focus();
}
