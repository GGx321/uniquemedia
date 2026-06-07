import type { CopyOptions, ExportFormat } from "../../core/types";
import { DropZone, type Source } from "./DropZone";
import { NField } from "./NField";
import { FormatSelect } from "./FormatSelect";
import { AdvancedPanel, type AdvancedValue } from "./AdvancedPanel";
import { RunButton } from "./RunButton";

export interface SettingsState {
  count: number;
  format: ExportFormat;
  advanced: AdvancedValue;
}

export function settingsToOptions(s: SettingsState): CopyOptions {
  return {
    strength: s.advanced.strength,
    exportFormat: s.format,
    keepTrendAudio: s.advanced.keepTrendAudio,
    allowMirror: s.advanced.allowMirror,
    targetDistance: s.advanced.targetDistance,
    spoofMetadata: s.advanced.spoofMetadata,
  };
}

export function SettingsPanel({
  source,
  state,
  running,
  analyzing,
  onPick,
  onDropFile,
  onChange,
  onRun,
  onStop,
}: {
  source: Source | null;
  state: SettingsState;
  running: boolean;
  analyzing?: boolean;
  onPick: () => void;
  onDropFile: (path: string) => void;
  onChange: (s: SettingsState) => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const set = (patch: Partial<SettingsState>) => onChange({ ...state, ...patch });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DropZone source={source} analyzing={analyzing} onPick={onPick} onDropFile={onDropFile} />
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><NField value={state.count} onChange={(count) => set({ count })} /></div>
        <div style={{ flex: 1 }}><FormatSelect value={state.format} onChange={(format) => set({ format })} /></div>
      </div>
      <AdvancedPanel value={state.advanced} onChange={(advanced) => set({ advanced })} />
      <RunButton disabled={!source} running={running} onClick={onRun} onStop={onStop} />
    </div>
  );
}
