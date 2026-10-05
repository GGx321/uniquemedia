// Which keys belong to the focused control and which to the editor (the 3d.3a review). One rule for the whole editor:
// - ⌘Z / ⇧⌘Z are the draft's undo and redo unless the owner is typing (`isTextEntry`): a text field keeps its own
//   undo; a slider, a box or a button keeps none, so there they are the draft's;
// - Delete, Escape and the arrows are the control's own whenever it is a form control or editable text
//   (`ownsKeys`): Delete on the «Длительность» slider never deletes the clip;
// - Space plays and pauses the montage (2026-10-05), on a button too, unless it is the control's own (`spacePlays`).
// A key that ends an input method's composition is the composition's (`KeyboardEvent.isComposing`), checked by the
// callers on the native event.

/** Inputs that take no typed text: they have no undo of their own. */
const NOT_TEXT = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "image", "color", "file"]);

/** The owner is typing text: a text-entry input, a textarea, a select (type-ahead) or editable text. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) return !NOT_TEXT.has(target.type);
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** What `spacePlays` reads of a key event. */
export type SpaceKey = Pick<KeyboardEvent, "key" | "target" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "isComposing" | "defaultPrevented">;

/** Where Space keeps its own meaning, whatever is focused inside: an open dialog and the menus and lists that pop up. */
const OWN_SPACE = '[role="dialog"], [role="alertdialog"], dialog[open], [role="menu"], [role="menubar"], [role="listbox"]';
/** A modal open anywhere: the editor behind it takes no keys. */
const MODAL_OPEN = 'dialog[open], [aria-modal="true"]';

/**
 * Space plays and pauses the montage (the owner's feedback, 2026-10-05), and the caller then takes the key from the focused control (a
 * focused button is NOT also pressed: Enter still presses it). Not while typing (`isTextEntry`), not on a checkbox or a radio (Space is
 * their only key), not inside an open dialog or menu, not while a modal is open anywhere, not with a modifier, not when the control already
 * took the key.
 */
export function spacePlays(event: SpaceKey, doc: Document): boolean {
  if (event.key !== " " || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.defaultPrevented) return false;
  const target = event.target;
  if (isTextEntry(target)) return false;
  if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) return false;
  if (target instanceof Element && target.closest(OWN_SPACE) !== null) return false;
  return doc.querySelector(MODAL_OPEN) === null;
}

/** A form control or editable text: it handles Delete, Escape and the arrows itself. */
export function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
