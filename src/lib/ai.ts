// OpenAI-compatible AI editing client targeting cli2api (http://localhost:8787/v1).
// Pure logic (prompt building, JSON extraction, action execution) is rune-free so
// it can be unit-tested directly under Vitest.

import { normalizeKeeps, type Keep } from "./cuts";
import { orchestratedChatCompletion } from "./orchestrator";
import type {
  DetectParams,
  ExportOptions,
  ExportQuality,
  ExportResolution,
  TranscriptSegment,
} from "./types";

export const DEFAULT_AI_BASE_URL = "http://localhost:8787/v1";
export const DEFAULT_AI_MODEL = "agy/gemini-3.8-flash-medium";

export type AiChatMessage = {
  role: "user" | "assistant";
  content: string;
  appliedActions?: string[];
  error?: boolean;
};

export type AiEditorContext = {
  filename: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  currentTime: number;
  params: DetectParams;
  keeps: Keep[];
  exportOptions: ExportOptions;
  transcript?: TranscriptSegment[];
};

export type AiAction =
  | {
      type: "set_params";
      threshold?: number;
      pad?: number;
      min_silence_ms?: number;
      min_speech_ms?: number;
      run_detect?: boolean;
    }
  | { type: "detect_silences" }
  | { type: "trim_edges"; cut_start?: number; cut_end?: number }
  | { type: "keep_only_range"; start: number; end: number }
  | { type: "remove_range"; start: number; end: number }
  | { type: "add_keep"; start: number; end: number }
  | {
      type: "set_keeps";
      keeps: { start: number; end: number; disabled?: boolean }[];
    }
  | { type: "filter_short_keeps"; min_duration: number }
  | { type: "merge_close_keeps"; max_gap: number }
  | { type: "disable_keeps"; indices: number[] }
  | { type: "enable_keeps"; indices: number[] }
  | {
      type: "set_export_options";
      quality?: ExportQuality;
      resolution?: ExportResolution;
    }
  | { type: "seek"; time: number }
  | { type: "reset_cuts" };

export type AiParsedResponse = {
  reply: string;
  actions: AiAction[];
};

export type AiApplyResult = {
  nextParams: DetectParams;
  paramsChanged: boolean;
  triggerDetect: boolean;
  nextKeeps: Keep[] | null;
  nextExportOptions: ExportOptions;
  exportOptionsChanged: boolean;
  seekTo: number | null;
  summaries: string[];
};

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_AI_BASE_URL;
  return trimmed;
}

export async function fetchAvailableModels(
  baseUrl: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const headers: Record<string, string> = {};
  if (apiKey?.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids;
}

export function pickPreferredModel(models: string[], current?: string): string {
  if (current && models.includes(current)) return current;
  if (models.includes("agy")) return "agy";
  const preferred = ["claude", "gemini", "codex"];
  for (const p of preferred) {
    if (models.includes(p)) return p;
  }
  return models[0] ?? current ?? DEFAULT_AI_MODEL;
}

export function buildSystemPrompt(ctx: AiEditorContext): string {
  const activeKeeps = ctx.keeps.filter((k) => !k.disabled);
  const keptSeconds = activeKeeps.reduce((acc, k) => acc + (k.end - k.start), 0);
  const keepLines =
    ctx.keeps.length === 0
      ? "  (no cuts yet — full video is unedited)"
      : ctx.keeps
          .slice(0, 60)
          .map(
            (k, i) =>
              `  #${i + 1}: ${k.start.toFixed(2)}s -> ${k.end.toFixed(2)}s (${(k.end - k.start).toFixed(2)}s)${k.disabled ? " [DISABLED]" : ""}`,
          )
          .join("\n") +
        (ctx.keeps.length > 60
          ? `\n  ... (${ctx.keeps.length - 60} more intervals)`
          : "");

  const transcriptBlock =
    ctx.transcript && ctx.transcript.length > 0
      ? `\nTRANSCRIPT (source timestamps):\n${ctx.transcript
          .slice(0, 80)
          .map((s) => `  [${s.start.toFixed(1)}s-${s.end.toFixed(1)}s] ${s.text}`)
          .join("\n")}${
          ctx.transcript.length > 80
            ? `\n  ... (${ctx.transcript.length - 80} more segments)`
            : ""
        }\n`
      : "";

  return `You are an expert AI Video Editor embedded inside the "autocut" desktop video editor.
You edit the user's video by returning a JSON object with a concise, friendly reply (in the same language as the user — Persian or English) AND a list of structured editing actions that autocut executes immediately on the timeline.

CURRENT VIDEO STATE:
- File: ${ctx.filename}
- Duration: ${ctx.duration.toFixed(2)}s | Resolution: ${ctx.width}x${ctx.height} | FPS: ${ctx.fps.toFixed(2)}
- Playhead: ${ctx.currentTime.toFixed(2)}s
- Detection params: threshold=${ctx.params.threshold.toFixed(2)} (0.10-0.95), pad=${ctx.params.pad.toFixed(2)}s (0-2.0), min_silence_ms=${ctx.params.min_silence_ms} (100-2000), min_speech_ms=${ctx.params.min_speech_ms} (100-2000)
- Export options: quality=${ctx.exportOptions.quality}, resolution=${ctx.exportOptions.resolution}
- Keeps: ${ctx.keeps.length} total (${activeKeeps.length} active, ${keptSeconds.toFixed(2)}s kept / ${ctx.duration.toFixed(2)}s total)
${keepLines}${transcriptBlock}

AVAILABLE ACTIONS (return in the "actions" array):
1. {"type":"set_params","threshold":0.6,"pad":0.15,"min_silence_ms":150,"min_speech_ms":150,"run_detect":true}
   - Tunes Silero VAD silence detection. Higher threshold & lower pad = tighter/snappier YouTube cuts. Lower threshold & higher pad = relaxed podcast cuts.
2. {"type":"detect_silences"}
   - Runs silence detection with current params.
3. {"type":"trim_edges","cut_start":5,"cut_end":3}
   - Removes N seconds from the beginning and/or end of the video.
4. {"type":"keep_only_range","start":10,"end":40}
   - Keeps only footage between start and end seconds.
5. {"type":"remove_range","start":12,"end":18}
   - Cuts out / deletes the time range [start, end] from the video.
6. {"type":"add_keep","start":5,"end":12}
   - Adds a kept interval.
7. {"type":"set_keeps","keeps":[{"start":0,"end":10},{"start":15,"end":30}]}
   - Replaces the full keep list.
8. {"type":"filter_short_keeps","min_duration":1.0}
   - Removes any kept clip shorter than min_duration seconds.
9. {"type":"merge_close_keeps","max_gap":0.5}
   - Merges kept clips separated by a silence shorter than max_gap seconds.
10. {"type":"disable_keeps","indices":[1,3]}
   - Disables specific clips by 1-based index (#1, #2, ...).
11. {"type":"enable_keeps","indices":[1,3]}
   - Re-enables disabled clips by 1-based index.
12. {"type":"set_export_options","quality":"high","resolution":"1080p"}
   - quality: "high" | "medium" | "small"; resolution: "source" | "1080p" | "720p" | "480p".
13. {"type":"seek","time":12.5}
   - Moves the video playhead to time (seconds).
14. {"type":"reset_cuts"}
   - Resets timeline to keep the entire video [0, duration].

RESPONSE FORMAT (STRICT JSON ONLY — NO MARKDOWN FENCES):
{
  "reply": "Short explanation of what you changed (or your answer if the user only asked a question)",
  "actions": []
}`;
}

export function parseAiResponse(raw: string): AiParsedResponse {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const candidates: string[] = [cleaned];

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        const reply =
          typeof parsed.reply === "string"
            ? parsed.reply
            : typeof parsed.message === "string"
              ? parsed.message
              : "Done.";
        const actions = Array.isArray(parsed.actions)
          ? (parsed.actions.filter(
              (a) => a && typeof a === "object" && typeof (a as { type?: unknown }).type === "string",
            ) as AiAction[])
          : [];
        return { reply, actions };
      }
    } catch {
      // Try next candidate
    }
  }

  return {
    reply: cleaned || "No response from model.",
    actions: [],
  };
}

export async function sendAiEditRequest(opts: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  autoSwitch?: boolean;
  history: AiChatMessage[];
  userMessage: string;
  context: AiEditorContext;
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
}): Promise<AiParsedResponse & { modelUsed: string; switchedFrom?: string }> {
  const recentHistory = opts.history
    .filter((m) => !m.error)
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await orchestratedChatCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    task: "chat_edit",
    preferredModel: opts.model,
    autoSwitch: opts.autoSwitch,
    responseFormatJson: true,
    signal: opts.signal,
    onStatus: opts.onStatus,
    messages: [
      { role: "system", content: buildSystemPrompt(opts.context) },
      ...recentHistory,
      { role: "user", content: opts.userMessage },
    ],
  });

  const parsed = parseAiResponse(res.content);
  return {
    ...parsed,
    modelUsed: res.modelUsed,
    switchedFrom: res.switchedFrom,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function ensureWorkingKeeps(keeps: Keep[] | null, initial: Keep[], duration: number): Keep[] {
  const current = keeps ?? initial;
  if (current.length > 0) return current.map((k) => ({ ...k }));
  if (duration > 0) return [{ start: 0, end: duration, disabled: false }];
  return [];
}

export function applyAiActions(
  actions: AiAction[],
  state: {
    duration: number;
    params: DetectParams;
    keeps: Keep[];
    exportOptions: ExportOptions;
  },
): AiApplyResult {
  const duration = state.duration;
  const nextParams: DetectParams = { ...state.params };
  let paramsChanged = false;
  let triggerDetect = false;
  let nextKeeps: Keep[] | null = null;
  const nextExportOptions: ExportOptions = { ...state.exportOptions };
  let exportOptionsChanged = false;
  let seekTo: number | null = null;
  const summaries: string[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "set_params": {
        const parts: string[] = [];
        if (typeof action.threshold === "number" && Number.isFinite(action.threshold)) {
          nextParams.threshold = clamp(action.threshold, 0.1, 0.95);
          paramsChanged = true;
          parts.push(`threshold=${nextParams.threshold.toFixed(2)}`);
        }
        if (typeof action.pad === "number" && Number.isFinite(action.pad)) {
          nextParams.pad = clamp(action.pad, 0, 2);
          paramsChanged = true;
          parts.push(`pad=${nextParams.pad.toFixed(2)}s`);
        }
        if (
          typeof action.min_silence_ms === "number" &&
          Number.isFinite(action.min_silence_ms)
        ) {
          nextParams.min_silence_ms = Math.round(clamp(action.min_silence_ms, 100, 2000));
          paramsChanged = true;
          parts.push(`min_silence=${nextParams.min_silence_ms}ms`);
        }
        if (
          typeof action.min_speech_ms === "number" &&
          Number.isFinite(action.min_speech_ms)
        ) {
          nextParams.min_speech_ms = Math.round(clamp(action.min_speech_ms, 100, 2000));
          paramsChanged = true;
          parts.push(`min_speech=${nextParams.min_speech_ms}ms`);
        }
        if (action.run_detect !== false) {
          triggerDetect = true;
        }
        if (parts.length) {
          summaries.push(`params: ${parts.join(", ")}`);
        }
        break;
      }

      case "detect_silences": {
        triggerDetect = true;
        summaries.push("run silence detection");
        break;
      }

      case "trim_edges": {
        const cutStart = Math.max(0, Number(action.cut_start ?? 0) || 0);
        const cutEnd = Math.max(0, Number(action.cut_end ?? 0) || 0);
        const lo = clamp(cutStart, 0, duration);
        const hi = clamp(duration - cutEnd, lo, duration);
        const base = ensureWorkingKeeps(nextKeeps, state.keeps, duration);
        nextKeeps = normalizeKeeps(
          base
            .map((k) => ({
              start: Math.max(k.start, lo),
              end: Math.min(k.end, hi),
              disabled: k.disabled,
            }))
            .filter((k) => k.end > k.start),
          duration,
        );
        summaries.push(`trimmed ${cutStart.toFixed(1)}s start / ${cutEnd.toFixed(1)}s end`);
        break;
      }

      case "keep_only_range": {
        const lo = clamp(Number(action.start) || 0, 0, duration);
        const hi = clamp(Number(action.end) || duration, lo, duration);
        const base = ensureWorkingKeeps(nextKeeps, state.keeps, duration);
        nextKeeps = normalizeKeeps(
          base
            .map((k) => ({
              start: Math.max(k.start, lo),
              end: Math.min(k.end, hi),
              disabled: k.disabled,
            }))
            .filter((k) => k.end > k.start),
          duration,
        );
        summaries.push(`kept only ${lo.toFixed(1)}s → ${hi.toFixed(1)}s`);
        break;
      }

      case "remove_range": {
        const rStart = clamp(Number(action.start) || 0, 0, duration);
        const rEnd = clamp(Number(action.end) || 0, rStart, duration);
        if (rEnd > rStart) {
          const base = ensureWorkingKeeps(nextKeeps, state.keeps, duration);
          const out: Keep[] = [];
          for (const k of base) {
            if (k.end <= rStart || k.start >= rEnd) {
              out.push(k);
            } else {
              if (k.start < rStart) {
                out.push({ start: k.start, end: rStart, disabled: k.disabled });
              }
              if (k.end > rEnd) {
                out.push({ start: rEnd, end: k.end, disabled: k.disabled });
              }
            }
          }
          nextKeeps = normalizeKeeps(out, duration);
          summaries.push(`removed ${rStart.toFixed(1)}s → ${rEnd.toFixed(1)}s`);
        }
        break;
      }

      case "add_keep": {
        const s = clamp(Number(action.start) || 0, 0, duration);
        const e = clamp(Number(action.end) || 0, s, duration);
        if (e > s) {
          const base = (nextKeeps ?? state.keeps).map((k) => ({ ...k }));
          base.push({ start: s, end: e, disabled: false });
          nextKeeps = normalizeKeeps(base, duration);
          summaries.push(`added keep ${s.toFixed(1)}s → ${e.toFixed(1)}s`);
        }
        break;
      }

      case "set_keeps": {
        if (Array.isArray(action.keeps)) {
          nextKeeps = normalizeKeeps(action.keeps, duration);
          summaries.push(`set ${nextKeeps.length} keep intervals`);
        }
        break;
      }

      case "filter_short_keeps": {
        const minDur = Math.max(0, Number(action.min_duration) || 0);
        const base = (nextKeeps ?? state.keeps).map((k) => ({ ...k }));
        const before = base.length;
        const kept = base.filter((k) => k.end - k.start >= minDur);
        nextKeeps = normalizeKeeps(kept, duration);
        summaries.push(`removed ${before - nextKeeps.length} clips < ${minDur.toFixed(2)}s`);
        break;
      }

      case "merge_close_keeps": {
        const maxGap = Math.max(0, Number(action.max_gap) || 0);
        const base = normalizeKeeps(nextKeeps ?? state.keeps, duration);
        const merged: Keep[] = [];
        for (const k of base) {
          const prev = merged[merged.length - 1];
          if (prev && !prev.disabled && !k.disabled && k.start - prev.end <= maxGap) {
            prev.end = k.end;
          } else {
            merged.push({ ...k });
          }
        }
        nextKeeps = merged;
        summaries.push(`merged gaps ≤ ${maxGap.toFixed(2)}s (${merged.length} clips)`);
        break;
      }

      case "disable_keeps": {
        const set = new Set((action.indices ?? []).map((n) => Math.round(n) - 1));
        const base = (nextKeeps ?? state.keeps).map((k, idx) =>
          set.has(idx) ? { ...k, disabled: true } : { ...k },
        );
        nextKeeps = normalizeKeeps(base, duration);
        summaries.push(`disabled ${set.size} clip(s)`);
        break;
      }

      case "enable_keeps": {
        const set = new Set((action.indices ?? []).map((n) => Math.round(n) - 1));
        const base = (nextKeeps ?? state.keeps).map((k, idx) =>
          set.has(idx) ? { ...k, disabled: false } : { ...k },
        );
        nextKeeps = normalizeKeeps(base, duration);
        summaries.push(`enabled ${set.size} clip(s)`);
        break;
      }

      case "set_export_options": {
        const validQ: ExportQuality[] = ["high", "medium", "small"];
        const validR: ExportResolution[] = ["source", "1080p", "720p", "480p"];
        const parts: string[] = [];
        if (action.quality && validQ.includes(action.quality)) {
          nextExportOptions.quality = action.quality;
          exportOptionsChanged = true;
          parts.push(action.quality);
        }
        if (action.resolution && validR.includes(action.resolution)) {
          nextExportOptions.resolution = action.resolution;
          exportOptionsChanged = true;
          parts.push(action.resolution);
        }
        if (parts.length) {
          summaries.push(`export: ${parts.join(" · ")}`);
        }
        break;
      }

      case "seek": {
        if (typeof action.time === "number" && Number.isFinite(action.time)) {
          seekTo = clamp(action.time, 0, duration);
          summaries.push(`seek → ${seekTo.toFixed(2)}s`);
        }
        break;
      }

      case "reset_cuts": {
        nextKeeps = duration > 0 ? [{ start: 0, end: duration, disabled: false }] : [];
        summaries.push("reset timeline to full video");
        break;
      }
    }
  }

  return {
    nextParams,
    paramsChanged,
    triggerDetect,
    nextKeeps,
    nextExportOptions,
    exportOptionsChanged,
    seekTo,
    summaries,
  };
}
