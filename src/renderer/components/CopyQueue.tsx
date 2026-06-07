import type { UiCopy } from "../types";
import { CopyCard } from "./CopyCard";

export function CopyQueue({
  copies,
  onOpen,
  onReveal,
}: {
  copies: UiCopy[];
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
}) {
  if (copies.length === 0) {
    return (
      <div className="queue-empty">
        <svg className="glyph" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="6" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="m17 10 4-2v8l-4-2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <p>Очередь пуста — перетащите видео и нажмите «Уникализировать».</p>
      </div>
    );
  }
  return (
    <div className="queue">
      {copies.map((c) => (
        <CopyCard key={c.index} copy={c} onOpen={onOpen} onReveal={onReveal} />
      ))}
    </div>
  );
}
