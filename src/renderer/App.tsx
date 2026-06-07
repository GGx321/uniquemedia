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
  format: "reels",
  advanced: { keepTrendAudio: false, allowMirror: false, targetDistance: 60, strength: 1.0, spoofMetadata: true },
};

export function App() {
  const [source, setSource] = useState<Source | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [state, setState] = useState<SettingsState>(initial);
  const [copies, setCopies] = useState<UiCopy[]>([]);
  const [running, setRunning] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ index: 0, count: 0, fraction: 0 });
  const pathByIndex = useRef(new Map<number, string>());

  useEffect(() => {
    api.onBatchProgress((p) => {
      setProgress(p);
      setCopies((cs) => upsert(cs, { index: p.index, name: `Копия ${p.index + 1}`, status: "rendering", fraction: p.fraction }));
    });
    api.onCopyDone((c) => {
      pathByIndex.current.set(c.index, c.path);
      setCopies((cs) => upsert(cs, {
        index: c.index, name: basename(c.path), status: "done",
        thumb: c.thumb, verify: c.verify,
      }));
    });
    api.onBatchDone(() => { setRunning(false); setProgress((p) => ({ ...p, count: 0 })); });
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
      setProgress({ index: 0, count: 0, fraction: 0 });
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
    setProgress({ index: 0, count: state.count, fraction: 0 });
    await api.start({ input: sourcePath, opts: settingsToOptions(state), count: state.count, outDir });
  }

  function stop() {
    api.cancel();
    setRunning(false);
    setProgress({ index: 0, count: 0, fraction: 0 });
    setCopies((cs) => cs.filter((c) => c.status === "done"));
  }

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
          <span />
          <span />
          <span />
        </span>
        <span className="wordmark">unique<b>media</b></span>
        <span className="tagline">video uniquifier</span>
        <span className="header-spacer" />
        <span className="version">v0.2.0</span>
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
          <BatchProgress index={progress.index} count={progress.count} fraction={progress.fraction} />
        </aside>
        <main className="col-queue reveal reveal-3">
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
