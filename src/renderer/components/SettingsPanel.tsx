import type { CopyOptions, ExportFormat, PhotoCopyOptions } from "../../core/types";
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

/** The half of the settings that means something for either medium. One state,
 *  two derivations — so a still never carries a soundtrack flag it cannot use. */
export function settingsToPhotoOptions(s: SettingsState): PhotoCopyOptions {
  return {
    strength: s.advanced.strength,
    exportFormat: s.format,
    allowMirror: s.advanced.allowMirror,
    targetDistance: s.advanced.targetDistance,
    identity: s.advanced.identity,
    edgeMode: s.advanced.edgeMode,
  };
}

export function settingsToOptions(s: SettingsState): CopyOptions {
  return {
    ...settingsToPhotoOptions(s),
    keepTrendAudio: s.advanced.keepTrendAudio,
    firstFrame: s.advanced.firstFrame,
    // The path alone: the thumbnail is the panel's, and main reads the file.
    coverPath: s.advanced.cover?.path ?? null,
  };
}

/**
 * Whether Run has to wait for a picture: the first frame is to be a photo,
 * none has been chosen, and the source is footage — a still has no first
 * frame to fill, so the mode (hidden for it) must not hold it back.
 */
export function coverMissing(source: Source | null, s: SettingsState): boolean {
  if (source?.info.kind === "photo") return false;
  return s.advanced.firstFrame === "photo" && s.advanced.cover === null;
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
  onPickCover,
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
  /** Opens the host's image dialog for the photo first frame. */
  onPickCover: () => void;
}) {
  const set = (patch: Partial<SettingsState>) => onChange({ ...state, ...patch });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <DropZone source={source} analyzing={analyzing} onPick={onPick} onDropFile={onDropFile} />
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><NField value={state.count} onChange={(count) => set({ count })} /></div>
        <div style={{ flex: 1 }}><FormatSelect value={state.format} onChange={(format) => set({ format })} /></div>
      </div>
      <AdvancedPanel
        // Before a source is chosen there is nothing to hide, so the panel
        // shows its full set; the kind narrows it once the file is probed.
        kind={source?.info.kind ?? "video"}
        value={state.advanced}
        onChange={(advanced) => set({ advanced })}
        onPickCover={onPickCover}
        pickCoverDisabled={running}
      />
      <RunButton
        disabled={!source || coverMissing(source, state)}
        running={running}
        onClick={onRun}
        onStop={onStop}
      />
    </div>
  );
}
