import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EngineError, Estimate } from "../../../shared/engine";
import { useMounted } from "./shared";

// CS.6: one paid button's rules, the generate card's own (GenerateCard.tsx), for the review's many paid buttons (compose, «Дописать», «Отрисовать», ⟳,
// «Написать N сцен», «Повторить», «Другие сцены для N»):
// - its price is asked (free) for exactly one `key` — the request and the settings that move its price — and shown only for that key;
// - a click sends exactly that price as `acceptedWorstMicros`, never twice (a second click before the re-render sends nothing), and never by itself;
// - PRICE_CHANGED keeps the button busy until a fresh price replaces the refused one, which then needs a new click; a failed re-price leaves no price;
// - while it sends, the avatar's paid lock (the store's `paidInFlightAvatars`) holds every other paid button of the screen.

export type Reply<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: EngineError };

export interface PaidActionOptions<R> {
  /** What the price belongs to; null when there is nothing to price (the button offers no paid send). */
  readonly key: string | null;
  readonly price: () => Promise<Reply<{ estimate: Estimate }>>;
  readonly send: (acceptedWorstMicros: number) => Promise<Reply<R>>;
  /** The send was accepted. Called even when the screen is gone: what it records (the store, the slice) is the window's. */
  readonly onSent: (result: R, accepted: Estimate) => void;
  /** The send was refused for another reason than its price. */
  readonly onRefused?: (error: EngineError) => void;
  readonly onPaidInFlightChange: (inFlight: boolean) => void;
}

export interface PaidAction {
  /** The price for the current key; null while it is asked, and when the ask failed. */
  readonly estimate: Estimate | null;
  readonly estimating: boolean;
  readonly priceError: EngineError | null;
  /** PRICE_CHANGED: the worst case the refused click had accepted («Подтвердить новую цену»). */
  readonly previousWorst: number | null;
  readonly sending: boolean;
  /** What the click that is sending accepted: the button shows it, not a fresher price. */
  readonly sentWorst: number | null;
  /** The last send's refusal (not PRICE_CHANGED). */
  readonly error: EngineError | null;
  /** Sends at the shown price; nothing without one, and nothing while one is on its way. */
  readonly click: () => void;
  readonly retryPrice: () => void;
  readonly clearError: () => void;
}

interface Priced {
  readonly key: string;
  readonly estimate: Estimate;
}

export function usePaidAction<R>({ key, price, send, onSent, onRefused, onPaidInFlightChange }: PaidActionOptions<R>): PaidAction {
  const mounted = useMounted();
  const sendingRef = useRef(false);
  const keyRef = useRef<string | null>(key);
  const latest = useRef({ price, send, onSent, onRefused, onPaidInFlightChange });
  useLayoutEffect(() => {
    keyRef.current = key;
    latest.current = { price, send, onSent, onRefused, onPaidInFlightChange };
  });
  const [priced, setPriced] = useState<Priced | null>(null);
  const [priceError, setPriceError] = useState<{ key: string; error: EngineError } | null>(null);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [sentWorst, setSentWorst] = useState<number | null>(null);
  const [error, setError] = useState<EngineError | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void latest.current.price().then((reply) => {
      if (!alive) return;
      if (reply.ok) {
        setPriced({ key, estimate: reply.result.estimate });
        setPriceError(null);
        setPreviousWorst(null);
      } else {
        setPriced(null);
        setPriceError({ key, error: reply.error });
      }
    });
    return () => {
      alive = false;
    };
  }, [key, retry]);

  const current = priced !== null && priced.key === key ? priced.estimate : null;
  const currentError = priceError !== null && priceError.key === key ? priceError.error : null;

  async function go(accepted: Estimate, acceptedKey: string): Promise<void> {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSentWorst(accepted.worstMicros);
    setError(null);
    latest.current.onPaidInFlightChange(true);
    try {
      const reply = await latest.current.send(accepted.worstMicros);
      if (reply.ok) {
        latest.current.onSent(reply.result, accepted);
        if (mounted.current) setPreviousWorst(null);
        return;
      }
      if (reply.error.code !== "PRICE_CHANGED") {
        latest.current.onRefused?.(reply.error);
        if (mounted.current) setError(reply.error);
        return;
      }
      // Still busy: the refused price stays on the disabled button until the fresh one replaces it, for a new click.
      const fresh = await latest.current.price();
      if (!mounted.current || keyRef.current !== acceptedKey) return;
      if (fresh.ok) {
        setPriced({ key: acceptedKey, estimate: fresh.result.estimate });
        setPreviousWorst(accepted.worstMicros);
        return;
      }
      setPriced(null);
      setPreviousWorst(null);
      setPriceError({ key: acceptedKey, error: fresh.error });
    } finally {
      sendingRef.current = false;
      latest.current.onPaidInFlightChange(false);
      if (mounted.current) {
        setSending(false);
        setSentWorst(null);
      }
    }
  }

  return {
    estimate: current,
    estimating: key !== null && current === null && currentError === null,
    priceError: currentError,
    previousWorst: current === null ? null : previousWorst,
    sending,
    sentWorst,
    error,
    click: () => {
      if (current !== null && key !== null) void go(current, key);
    },
    retryPrice: () => setRetry((n) => n + 1),
    clearError: () => setError(null),
  };
}
