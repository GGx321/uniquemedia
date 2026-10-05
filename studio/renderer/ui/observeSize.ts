// One ResizeObserver for every element that asks (a gallery holds hundreds of portraits), made on the first ask and dropped with
// the last, like the one pixel-ratio query in useDevicePixelRatio.ts. Each element has one listener, told its content box.

export interface ContentSize {
  readonly width: number;
  readonly height: number;
}

type Listener = (size: ContentSize) => void;

const listeners = new Map<Element, Listener>();
let observer: ResizeObserver | null = null;

function report(entries: readonly ResizeObserverEntry[]): void {
  for (const entry of entries) listeners.get(entry.target)?.({ width: entry.contentRect.width, height: entry.contentRect.height });
}

/** Tells `listener` each new content-box size of `element` until the returned function is called. Nothing where there is no ResizeObserver. */
export function observeSize(element: Element, listener: Listener): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  observer ??= new ResizeObserver(report);
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    // A later listener for the same element (a re-run effect) is not this one's to drop.
    if (listeners.get(element) !== listener) return;
    listeners.delete(element);
    observer?.unobserve(element);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = null;
  };
}
