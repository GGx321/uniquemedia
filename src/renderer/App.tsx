import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { UiCopy } from "./types";
import type { Source } from "./components/DropZone";
import { SettingsPanel, settingsToOptions, type SettingsState } from "./components/SettingsPanel";
import { CopyQueue } from "./components/CopyQueue";
import { BatchProgress } from "./components/BatchProgress";
import { basename } from "./util";

const initial: SettingsState = {
  count: 10,
  format: "original",
  advanced: { keepResolution: true, keepTrendAudio: false, allowMirror: false, targetDistance: 60, strength: 1.0, spoofMetadata: true },
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
  const pathByIndex = useRef(new Map<number, string>());

  useEffect(() => {
    // Per-copy render fraction only updates THAT copy's card; it no longer
    // feeds the overall progress.
    api.onBatchProgress((p) => {
      setCopies((cs) => upsert(cs, { index: p.index, name: `Копия ${p.index + 1}`, status: "rendering", fraction: p.fraction }));
    });
    api.onCopyDone((c) => {
      pathByIndex.current.set(c.index, c.path);
      setCopies((cs) => upsert(cs, {
        index: c.index, name: basename(c.path), status: "done",
        thumb: c.thumb, verify: c.verify,
      }));
    });
    api.onBatchDone(() => { setRunning(false); setCount(0); });
    api.onError((e) => { setRunning(false); alert(e.message); });
  }, []);

  async function loadSource(path: string) {
    setAnalyzing(true);
    try {
      const info = await api.probe(path);
      setSourcePath(path);
      setSource({ name: basename(path), info });
      // new source -> reset the queue and progress
      setCopies([]);
      setCount(0);
      pathByIndex.current.clear();
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
    await api.start({ input: sourcePath, opts: settingsToOptions(state), count: state.count, outDir });
  }

  function stop() {
    api.cancel();
    setRunning(false);
    setCount(0);
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
          <span className="tagline">video uniquifier</span>
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
          />
        </aside>
        <main className="col-queue reveal reveal-3">
          <div className="queue-head">
            <h2 className="queue-heading">
              Очередь
              {copies.length > 0 && <span className="queue-count">{copies.length}</span>}
            </h2>
            <BatchProgress index={completedCount - 1} count={count} fraction={count > 0 ? completedCount / count : 0} />
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
