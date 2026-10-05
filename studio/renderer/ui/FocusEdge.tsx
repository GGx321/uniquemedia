/**
 * The first and the last child of a modal dialog: where the browser's own Tab lands when it leaves the dialog's last control
 * (`end`) or goes back past its first (`start`). useModalDialog turns the focus round from there (by the direction of the last
 * Tab), so Tab itself is never held back and a control with parts of its own (a `<video controls>`, whose buttons live in its
 * shadow tree) is walked as usual. A file of its own, so the hook's module exports no component (Fast Refresh).
 */
export function FocusEdge({ edge }: { edge: "start" | "end" }) {
  return <span className="focus-edge" tabIndex={0} data-focus-edge={edge} />;
}
