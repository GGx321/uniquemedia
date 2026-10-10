import { useEffect, useRef, useState } from "react";
import type { DescriptorCheck, EngineError, Estimate } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import type { LookLanding } from "../../navigation";
import { useMounted } from "../photos/shared";
import type { CheckContext, LastCheck } from "./lookModel";

// S5.0d: the descriptor check of one avatar's «Внешность», held by the avatar's screen (not by the tab), so a look at «Фото» and back keeps the
// verdict. It is not kept past the screen (plan §5.3: a lost result costs one more check). The paid command is only ever sent with a worst case the
// owner saw: the button's own «до $X» from `avatars.estimateCheckDescriptor`, or the one the wizard showed under «Сохранить» (`landing`).

export type CheckPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly context: CheckContext }
  | { readonly kind: "done"; readonly check: DescriptorCheck; readonly context: CheckContext; readonly at: Date }
  | { readonly kind: "failed"; readonly error: EngineError; readonly context: CheckContext }
  /** The import's own check gave nothing (refused, timed out or unreadable): the avatar is kept, and a check can be asked for here. */
  | { readonly kind: "missed" };

/** What became of a check's proposal: offered, kept as it was («Оставить»), applied («Исправить описание»), or stale (the text moved first). */
export type ProposalFate = "open" | "kept" | "applied" | "stale";

export interface LookCheck {
  readonly phase: CheckPhase;
  /** The latest finished check of this visit, for «последняя: …». */
  readonly last: LastCheck | null;
  /** The engine's price of one check; null while it is asked for, or when it could not be had. */
  readonly estimate: Estimate | null;
  readonly estimating: boolean;
  readonly estimateError: EngineError | null;
  /** The worst case accepted before a PRICE_CHANGED: «Было не больше $A, теперь не больше $B». */
  readonly previousWorst: number | null;
  readonly fate: ProposalFate;
  /** «Проверить описание» and its variants: sends the check at the price on the button. */
  run(): void;
  /** Asks for the price again after it could not be had. */
  reprice(): void;
  settle(fate: Exclude<ProposalFate, "open">): void;
}

/**
 * «прочитано с фото»: true while the description is still the one the import read. Held by the avatar's screen, as the verdict is: once the text
 * changes on this screen the tag is gone for good, and a look at «Фото» and back does not bring it back.
 */
export function useReadFromPhoto(landing: LookLanding | null, text: string): boolean {
  const [read, setRead] = useState<string | null>(() => (landing?.kind === "imported" ? text : null));
  useEffect(() => {
    if (read !== null && read !== text) setRead(null);
  }, [read, text]);
  return read !== null && read === text;
}

/** Landings already acted on: a screen mounted again for the same route (React's development double mount, say) never sends a second paid check. */
const consumed = new WeakSet<LookLanding>();

function initialPhase(landing: LookLanding | null, at: Date): CheckPhase {
  if (landing?.kind !== "imported") return { kind: "idle" };
  return landing.check === null ? { kind: "missed" } : { kind: "done", check: landing.check, context: "import", at };
}

/**
 * `shown`: the tab is on screen (its price is asked for then, not on every visit to «Фото»); `ready`: the engine answers; `paidBlocked`: a paid
 * command would be refused before any spend (no key, offline, a halt) — the automatic check after «Сохранить» is then not sent at all, and the card
 * says why.
 */
export function useLookCheck(avatarId: string, landing: LookLanding | null, options: { shown: boolean; ready: boolean; paidBlocked: boolean }): LookCheck {
  const { shown, ready, paidBlocked } = options;
  const { client } = useEngine();
  const mounted = useMounted();
  const [opened] = useState(() => new Date());
  const [phase, setPhase] = useState<CheckPhase>(() => initialPhase(landing, opened));
  const [last, setLast] = useState<LastCheck | null>(() =>
    landing?.kind === "imported" && landing.check !== null ? { at: opened, context: "import", matches: landing.check.matches } : null,
  );
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<EngineError | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [fate, setFate] = useState<ProposalFate>("open");
  const [priceAsk, setPriceAsk] = useState(0);
  const sending = useRef(false);

  // The free price, asked for whenever the tab comes on screen; never a paid call — that waits for the button (or came accepted from the wizard).
  useEffect(() => {
    if (!ready || !shown) return;
    let alive = true;
    setEstimating(true);
    setEstimateError(null);
    void client.request("avatars.estimateCheckDescriptor", { avatarId }).then((reply) => {
      if (!alive) return;
      setEstimating(false);
      if (reply.ok) setEstimate(reply.result);
      else setEstimateError(reply.error);
    });
    return () => {
      alive = false;
    };
  }, [ready, shown, client, avatarId, priceAsk]);

  async function send(acceptedWorstMicros: number, context: CheckContext): Promise<void> {
    // Two clicks before the busy button is drawn must not buy two checks.
    if (sending.current) return;
    sending.current = true;
    try {
      await sendOnce(acceptedWorstMicros, context);
    } finally {
      sending.current = false;
    }
  }

  async function sendOnce(acceptedWorstMicros: number, context: CheckContext): Promise<void> {
    setPhase({ kind: "running", context });
    const reply = await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros });
    if (!mounted.current) return;
    if (reply.ok) {
      const at = new Date();
      setPhase({ kind: "done", check: reply.result.check, context, at });
      setLast({ at, context, matches: reply.result.check.matches });
      setFate("open");
      setPreviousWorst(null);
      return;
    }
    if (reply.error.code === "PRICE_CHANGED") {
      // Busy until the new price is on the button: the old one, just refused, must not be clickable meanwhile.
      const fresh = await client.request("avatars.estimateCheckDescriptor", { avatarId });
      if (!mounted.current) return;
      if (fresh.ok) {
        setEstimate(fresh.result);
        setPreviousWorst(acceptedWorstMicros);
      } else {
        setEstimate(null);
        setEstimateError(fresh.error);
      }
    }
    setPhase({ kind: "failed", error: reply.error, context });
  }

  // After «Сохранить»: the check the wizard priced under the button, sent once, at the worst case it showed.
  useEffect(() => {
    if (landing?.kind !== "created" || !ready || consumed.has(landing)) return;
    consumed.add(landing);
    if (landing.checkWorstMicros === null || paidBlocked) return;
    void send(landing.checkWorstMicros, "create");
  }, [landing, ready, paidBlocked]);

  return {
    phase,
    last,
    estimate,
    estimating,
    estimateError,
    previousWorst,
    fate,
    run() {
      if (estimate === null || phase.kind === "running") return;
      void send(estimate.worstMicros, "page");
    },
    reprice() {
      setPriceAsk((n) => n + 1);
    },
    settle(next) {
      setFate(next);
    },
  };
}
