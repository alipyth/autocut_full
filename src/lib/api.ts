import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CutList,
  DetectParams,
  DiagnosticInfo,
  ExportOptions,
  ExportProgressEvent,
  LinkedTrack,
  MediaInfo,
  PreparedChunks,
  SubtitleStyle,
  TrackProbe,
  VideoOverlay,
} from "./types";

export async function openVideo(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>("open_video", { path });
}

/// Probe a file to ride along as a linked track, and ask where it belongs.
/// The reference's timecode and rate go along so the offset can be derived
/// from embedded timecode when both sides have one.
export async function openTrack(
  path: string,
  referenceTimecode: string | null,
  fps: number,
): Promise<TrackProbe> {
  return invoke<TrackProbe>("open_track", {
    path,
    referenceTimecode,
    fps,
  });
}

export async function diagnosticInfo(): Promise<DiagnosticInfo> {
  return invoke<DiagnosticInfo>("diagnostic_info");
}

export async function computeWaveform(
  path: string,
  targetBins: number,
): Promise<number[]> {
  return invoke<number[]>("compute_waveform", { path, targetBins });
}

export async function detectSilence(
  path: string,
  duration: number,
  params: DetectParams,
): Promise<{ cutlist: CutList }> {
  return invoke<{ cutlist: CutList }>("detect_silence", {
    path,
    duration,
    params,
  });
}

export async function cancelDetect(): Promise<void> {
  await invoke("cancel_detect");
}

export async function exportMp4(
  source: string,
  output: string,
  cutlist: CutList,
  options: ExportOptions,
  hasAudio: boolean,
  burnSubtitlesSrt?: string | null,
  overlays: VideoOverlay[] = [],
  subtitleStyle?: SubtitleStyle,
): Promise<void> {
  await invoke("export_mp4", {
    args: {
      source,
      output,
      cutlist,
      quality: options.quality,
      resolution: options.resolution,
      has_audio: hasAudio,
      burn_subtitles_srt: burnSubtitlesSrt ?? null,
      subtitle_style: subtitleStyle
        ? {
            font_size: Math.round(subtitleStyle.fontSize),
            margin_v: Math.round(subtitleStyle.bottomPct * 2.8),
            color: subtitleStyle.color,
            bg_opacity: subtitleStyle.bgOpacity,
          }
        : undefined,
      normalize_audio: options.normalizeAudio === true,
      overlays: overlays.map((o) => ({
        path: o.path,
        start: o.start,
        end: o.end,
        mode: o.mode,
        scale: o.scale,
        x: o.x,
        y: o.y,
      })),
    },
  });
}

export async function prepareOverlayPreview(path: string): Promise<string> {
  return invoke<string>("prepare_overlay_preview", { path });
}

export async function prepareTranscriptionChunks(
  path: string,
  cutlist: CutList,
  maxChunkSecs = 45,
  workDir?: string | null,
): Promise<PreparedChunks> {
  return invoke<PreparedChunks>("prepare_transcription_chunks", {
    path,
    cutlist,
    maxChunkSecs,
    workDir: workDir ?? null,
  });
}

export async function cleanupTranscriptionChunks(dir: string): Promise<void> {
  await invoke("cleanup_transcription_chunks", { dir });
}

export async function writeTextFile(
  path: string,
  content: string,
): Promise<void> {
  await invoke("write_text_file", { path, content });
}

export async function cancelExport(): Promise<void> {
  await invoke("cancel_export");
}

export async function cancelWaveform(): Promise<void> {
  await invoke("cancel_waveform");
}

export async function revealInFinder(path: string): Promise<void> {
  await invoke("reveal_in_finder", { path });
}

export async function exportFcpxml(
  source: string,
  output: string,
  cutlist: CutList,
  fps: number,
  startTimecode: string | null,
  title: string,
  hasAudio: boolean,
  tracks: LinkedTrack[],
): Promise<void> {
  await invoke("export_fcpxml", {
    args: {
      source,
      output,
      cutlist,
      fps,
      start_timecode: startTimecode,
      title,
      has_audio: hasAudio,
      tracks: tracks.map((t) => ({
        source: t.info.path,
        name: t.info.path.split(/[/\\]/).pop() ?? t.info.path,
        duration: t.info.duration,
        start_timecode: t.info.start_timecode,
        has_video: t.info.has_video,
        has_audio: t.info.has_audio,
        offset: t.offset,
      })),
    },
  });
}

export function onExportProgress(
  handler: (e: ExportProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<ExportProgressEvent>("export-progress", (event) => {
    handler(event.payload);
  });
}
