import { useCallback, useEffect, useRef, useState } from "react";
import type { AutopilotGetResult, EngineError, LaunchSummary, UnreadableLaunch } from "../../../shared/engine";
import { useEngine, useEngineView } from "../../engine/react";
import { useMounted } from "../photos/shared";
import type { AvatarVideos } from "./historyModel";

// S4.9c: what the history and a launch's page read from the engine, and when. Every read is free: `autopilot.list`, `autopilot.get` and `videos.list`.
// - The list: on open, whenever the library's launch moves (another launch, another status), on `reread` (after «Убрать запись»), and for another library.
// - A launch: on open and whenever the engine's word on it changes (`autopilot.changed` of that launch), so the results of a launch that runs fill in. Since S4.6g its
//   answer carries the owner's marks and the deleted videos, so it is read again for a `video.changed` of one of its avatars (a mark, a delete, a render that landed), after
//   a resync and when an avatar leaves the library; and the screen asks again by itself after a mark and after a delete, failed or not (the work may still go on).
// - The avatars' records (`videos.list`), only to draw a finished video (poster, time, music): each on open, again for a `video.changed` of that avatar and after a resync.

export type LaunchListState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly launches: readonly LaunchSummary[]; readonly unreadable: readonly UnreadableLaunch[] }
  | { readonly state: "failed"; readonly error: EngineError };

/** `autopilot.list`: the launches, newest first, and the entries that cannot be read. */
export function useLaunchList(): { readonly list: LaunchListState; readonly reread: () => void } {
  const { client } = useEngine();
  const view = useEngineView();
  const ready = view.phase === "ready";
  const live = view.autopilot === null ? "none" : `${view.autopilot.launchId}:${view.autopilot.status}`;
  const library = view.settings?.libraryPath ?? null;
  const [attempt, setAttempt] = useState(0);
  const [list, setList] = useState<LaunchListState>({ state: "loading" });
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("autopilot.list", {}).then((reply) => {
      if (!alive) return;
      setList(reply.ok ? { state: "ready", launches: reply.result.launches, unreadable: reply.result.unreadable } : { state: "failed", error: reply.error });
    });
    return () => {
      alive = false;
    };
  }, [ready, client, live, library, attempt]);
  const reread = useCallback(() => setAttempt((n) => n + 1), []);
  return { list, reread };
}

export type LaunchDetailState =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly detail: AutopilotGetResult }
  | { readonly state: "failed"; readonly error: EngineError };

/** `autopilot.get` of one launch: its view, its log (the newest ≤ 500) and its videos. The last answer stays on screen while the next is asked. */
export function useLaunchDetail(launchId: string): {
  readonly detail: LaunchDetailState;
  readonly reread: () => void;
  /** How many answers (good or not) have landed: a screen that waits for a re-read to show a change tells it from the one before. */
  readonly reads: number;
} {
  const { client, store } = useEngine();
  const view = useEngineView();
  const ready = view.phase === "ready";
  // The engine's word on this very launch: a new one (a video done, a status) asks again.
  const live = view.autopilot !== null && view.autopilot.launchId === launchId ? view.autopilot : null;
  // An avatar that leaves the library takes its videos with it: the engine then calls them removed.
  const avatarsKnown = view.avatars.map((a) => a.avatarId).join("\n");
  const [attempt, setAttempt] = useState(0);
  const [reads, setReads] = useState(0);
  const [detail, setDetail] = useState<LaunchDetailState>({ state: "loading" });
  const avatarKey = detail.state === "ready" ? detail.detail.launch.draft.avatarIds.join("\n") : "";
  useEffect(
    () =>
      store.subscribeVideos((signal) => {
        if (avatarKey === "") return;
        if (signal.change === "resynced") return void setAttempt((n) => n + 1);
        const avatarId = signal.change === "upserted" ? signal.video.avatarId : signal.avatarId;
        if (avatarKey.split("\n").includes(avatarId)) setAttempt((n) => n + 1);
      }),
    [store, avatarKey],
  );
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    void client.request("autopilot.get", { launchId }).then((reply) => {
      if (!alive) return;
      setDetail((now) => (reply.ok ? { state: "ready", detail: reply.result } : now.state === "ready" ? now : { state: "failed", error: reply.error }));
      setReads((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [ready, client, launchId, live, attempt, avatarsKnown]);
  const reread = useCallback(() => setAttempt((n) => n + 1), []);
  return { detail, reread, reads };
}

/** The records `videos.list` answered for each of `avatarIds`, by video id, to draw the finished videos with; `reread` asks one avatar again. */
export function useAvatarVideoLists(avatarIds: readonly string[]): {
  readonly lists: ReadonlyMap<string, AvatarVideos>;
  readonly reread: (avatarId: string) => void;
} {
  const { client, store } = useEngine();
  const ready = useEngineView().phase === "ready";
  const mounted = useMounted();
  const key = avatarIds.join("\n");
  const [ticks, setTicks] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [lists, setLists] = useState<ReadonlyMap<string, AvatarVideos>>(() => new Map());
  /** The tick each avatar was last asked at: an answer for an older one is dropped. */
  const asked = useRef(new Map<string, number>());

  const bump = useCallback((ids: readonly string[]) => {
    setTicks((now) => {
      const next = new Map(now);
      for (const id of ids) next.set(id, (now.get(id) ?? 0) + 1);
      return next;
    });
  }, []);

  useEffect(
    () =>
      store.subscribeVideos((signal) => {
        const ids = key === "" ? [] : key.split("\n");
        if (signal.change === "resynced") bump(ids);
        else {
          const avatarId = signal.change === "upserted" ? signal.video.avatarId : signal.avatarId;
          if (ids.includes(avatarId)) bump([avatarId]);
        }
      }),
    [store, key, bump],
  );

  useEffect(() => {
    if (!ready || key === "") return;
    for (const avatarId of key.split("\n")) {
      const tick = ticks.get(avatarId) ?? 0;
      if (asked.current.get(avatarId) === tick) continue;
      asked.current.set(avatarId, tick);
      void client.request("videos.list", { avatarId }).then((reply) => {
        if (!mounted.current || asked.current.get(avatarId) !== tick) return;
        const answer: AvatarVideos = reply.ok ? { state: "ready", byId: new Map(reply.result.videos.map((v) => [v.videoId, v])) } : { state: "failed", error: reply.error };
        setLists((now) => new Map(now).set(avatarId, answer));
      });
    }
  }, [ready, client, key, ticks, mounted]);

  const reread = useCallback((avatarId: string) => bump([avatarId]), [bump]);
  return { lists, reread };
}
