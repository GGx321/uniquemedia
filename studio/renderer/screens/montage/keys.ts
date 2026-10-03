// Which keys belong to the focused control and which to the editor (the 3d.3a review). One rule for the whole editor:
// - ⌘Z / ⇧⌘Z are the draft's undo and redo unless the owner is typing (`isTextEntry`): a text field keeps its own
//   undo; a slider, a box or a button keeps none, so there they are the draft's;
// - Delete, Escape and the arrows are the control's own whenever it is a form control or editable text
//   (`ownsKeys`): Delete on the «Длительность» slider never deletes the clip.
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

/** A form control or editable text: it handles Delete, Escape and the arrows itself. */
export function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}
