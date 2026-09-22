import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { UiCopy } from "./types";
import type { Source } from "./components/DropZone";
import {
  SettingsPanel,
  settingsToOptions,
  settingsToPhotoOptions,
  type SettingsState,
} from "./components/SettingsPanel";
import { CopyQueue } from "./components/CopyQueue";
import { BatchProgress, type PostPassPhase } from "./components/BatchProgress";
import { basename } from "./util";

const initial: SettingsState = {
  count: 10,
  format: "original",
  advanced: {
    keepTrendAudio: false,
    allowMirror: false,
    targetDistance: 38,
    strength: 1.0,
    // iPhone by default, as the switch this replaced defaulted to on.
    identity: "iphone",
    // Defaults to deciding from the picture: padding is invisible on a flat
    // background and a visible border on a photograph, and the user should not
    // have to know which one they dropped in.
    edgeMode: "auto",
    firstFrame: "off",
    cover: null,
  },
};

export function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [state, setState] = useState<SettingsState>(initial);
  const [copies, setCopies] = useState<UiCopy[]>([]);
  const [running, setRunning] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  // Overall progress is "completed / total" (parallel-friendly): with copies
  // running concurrently there is no single "current" copy. `count` is the batch
  // total (0 hides BatchProgress); the completed tally derives from done cards.
  const [count, setCount] = useState(0);
  // The inter-copy check that follows the last copy. Every card is green by
  // then, so this is the only sign the batch is still doing something.
  const [postPass, setPostPass] = useState<PostPassPhase | null>(null);
  const pathByIndex = useRef(new Map<number, string>());

  useEffect(() => {
    // Per-copy render fraction only updates THAT copy's card; it no longer
    // feeds the overall progress. A card that already knows its file (one the
    // post-pass is regenerating) keeps that name rather than the placeholder.
    api.onBatchProgress((p) => {
      setCopies((cs) =>
        upsert(cs, {
          index: p.index,
          name: cs.find((c) => c.index === p.index)?.name ?? `Копия ${p.index + 1}`,
          status: "rendering",
          fraction: p.fraction,
        })
      );
    });
    // Fires again for a copy the post-pass regenerated: the card went back to
    // "rendering" on that render's progress ticks and returns to "done" here,
    // with the new picture and verification.
    api.onCopyDone((c) => {
      pathByIndex.current.set(c.index, c.path);
      setCopies((cs) => upsert(cs, {
        index: c.index, name: basename(c.path), status: "done",
        thumb: c.thumb, verify: c.verify,
      }));
    });
    api.onPostPass((p) => setPostPass(p));
    api.onBatchDone(() => { setRunning(false); setCount(0); setPostPass(null); });
    api.onError((e) => { setRunning(false); setPostPass(null); alert(e.message); });
  }, []);

  async function loadSource(path: string) {
    setAnalyzing(true);
    try {
      const info = await api.probe(path);
      // Null means main could not identify the file and has already said why
      // through onError — as its own sentence, rather than wrapped in the IPC
      // plumbing an error thrown across the bridge would arrive in.
      if (!info) return;
      setSourcePath(path);
      setSource({ name: basename(path), info });
      // new source -> reset the queue and progress
      setCopies([]);
      setCount(0);
      pathByIndex.current.clear();
    } catch (err) {
      // Identifying the file is now where an unreadable format is named — a
      // HEIC, say, which the bundled ffmpeg cannot open and which reports what
      // to do about it. Swallowing that would leave the user with a dropzone
      // that simply does nothing.
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  async function run() {
    if (!sourcePath) return;
    const outDir = await api.chooseOutDir();
    if (!outDir) return;
    setCopies([]);
    setRunning(true);
    setCount(state.count);
    setPostPass(null);
    // A still gets the options a still can use; main re-detects the kind from
    // the file itself, so a wrong guess here costs nothing.
    const opts =
      source?.info.kind === "photo" ? settingsToPhotoOptions(state) : settingsToOptions(state);
    await api.start({ input: sourcePath, opts, count: state.count, outDir });
  }

  /** The host's image dialog for the photo first frame. A null answer is a
   *  cancel, or a file main has already refused through `onError`; either way
   *  the state keeps whatever cover it had. */
  async function pickCover() {
    const cover = await api.pickCover();
    if (!cover) return;
    setState((s) => ({ ...s, advanced: { ...s.advanced, cover } }));
  }

  function stop() {
    api.cancel();
    setRunning(false);
    setCount(0);
    setPostPass(null);
    setCopies((cs) => cs.filter((c) => c.status === "done"));
  }

  // Overall progress = completed / total. BatchProgress reads the counter as
  // Math.min(index + 1, count), so index = completedCount - 1 makes it show
  // `completedCount/count`.
  const completedCount = copies.filter((c) => c.status === "done").length;

  const open = (name: string) => {
    const entry = [...pathByIndex.current.values()].find((p) => p.endsWith(name));
    if (entry) api.openFile(entry);
  };
  const reveal = (name: string) => {
    const entry = [...pathByIndex.current.values()].find((p) => p.endsWith(name));
    if (entry) api.revealInFolder(entry);
  };

  return (
    <div className="app">
      <header className="app-header reveal reveal-1">
        <span className="logo-mark" aria-hidden>
          <svg viewBox="0 0 32 32" fill="none">
            <defs>
              <linearGradient id="lm-grad" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
                <stop stopColor="var(--accent-2)" />
                <stop offset="1" stopColor="var(--accent-deep)" />
              </linearGradient>
            </defs>
            <rect className="lm-frame lm-frame-back" x="5.5" y="5.5" width="21" height="21" rx="6" />
            <rect className="lm-frame lm-frame-mid" x="5.5" y="5.5" width="21" height="21" rx="6" />
            <rect x="5.5" y="5.5" width="21" height="21" rx="6" stroke="url(#lm-grad)" strokeWidth="1.6" />
            <circle cx="16" cy="16" r="5" stroke="url(#lm-grad)" strokeWidth="1.6" />
            <circle className="lm-pupil" cx="16" cy="16" r="1.8" fill="var(--accent-2)" />
          </svg>
        </span>
        <span className="wordmark-lockup">
          <span className="wordmark">unique<b>media</b></span>
          <span className="tagline">media uniquifier</span>
        </span>
        <span className="header-spacer" />
        <span className="version">v{__APP_VERSION__}</span>
      </header>
      <div className="app-body">
        <aside className="col-settings reveal reveal-2">
          <SettingsPanel
            source={source}
            state={state}
            running={running}
            analyzing={analyzing}
            onPick={async () => { const p = await api.pickFile(); if (p) loadSource(p); }}
            onDropFile={loadSource}
            onChange={setState}
            onRun={run}
            onStop={stop}
            onPickCover={pickCover}
          />
        </aside>
        <main className="col-queue reveal reveal-3">
          <div className="queue-head">
            <h2 className="queue-heading">
              Очередь
              {copies.length > 0 && <span className="queue-count">{copies.length}</span>}
            </h2>
            <BatchProgress
              index={completedCount - 1}
              count={count}
              fraction={count > 0 ? completedCount / count : 0}
              postPass={running ? postPass : null}
            />
          </div>
          <CopyQueue copies={copies} onOpen={open} onReveal={reveal} />
        </main>
      </div>
    </div>
  );
}

function upsert(list: UiCopy[], item: UiCopy): UiCopy[] {
  const i = list.findIndex((c) => c.index === item.index);
  if (i === -1) return [...list, item].sort((a, b) => a.index - b.index);
  const next = list.slice();
  next[i] = { ...next[i], ...item };
  return next;
}
