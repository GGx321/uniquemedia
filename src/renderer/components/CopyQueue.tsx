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
    return <div style={{ color: "var(--muted)", padding: 24 }}>Queue is empty — drop a video and press Uniquify.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
      {copies.map((c) => (
        <CopyCard key={c.index} copy={c} onOpen={onOpen} onReveal={onReveal} />
      ))}
    </div>
  );
}
