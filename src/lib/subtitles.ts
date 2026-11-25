// Subtitle formatting, agy/Gemini chunked audio transcription, and YouTube
// Chapters / Metadata generation — powered by the Smart Model Orchestrator.

import type { Keep } from "./cuts";
import { orchestratedChatCompletion } from "./orchestrator";
import type { AudioChunk, TranscriptSegment } from "./types";

export type RemappedSegment = {
  start: number;
  end: number;
  sourceStart: number;
  text: string;
};

/// Convert a source-video timestamp (from the preview <video>) into the
/// corresponding exported (post-cut) timeline timestamp so overlays and
/// subtitles preview at the exact same moment they will appear in the MP4.
export function sourceTimeToExportTime(sourceTime: number, keeps: Keep[]): number {
  const active = keeps.filter((k) => !k.disabled && k.end > k.start);
  if (active.length === 0) return Math.max(0, sourceTime);
  let cursor = 0;
  for (const k of active) {
    if (sourceTime <= k.start) return cursor;
    if (sourceTime < k.end) return cursor + (sourceTime - k.start);
    cursor += k.end - k.start;
  }
  return cursor;
}

/// Remap source-timeline transcript segments onto the post-cut timeline.
/// (Kept for unit-tested compatibility & manual source-time imports.)
export function remapSegmentsToCutlist(
  segments: TranscriptSegment[],
  keeps: Keep[],
): RemappedSegment[] {
  if (segments.length === 0) return [];
  const active = keeps.filter((k) => !k.disabled && k.end > k.start);
  if (active.length === 0) {
    return segments
      .filter((s) => s.end > s.start && s.text.trim().length > 0)
      .map((s) => ({
        start: s.start,
        end: s.end,
        sourceStart: s.sourceStart ?? s.start,
        text: s.text.trim(),
      }));
  }

  const keepOffsets: { start: number; end: number; outStart: number }[] = [];
  let cursor = 0;
  for (const k of active) {
    keepOffsets.push({ start: k.start, end: k.end, outStart: cursor });
    cursor += k.end - k.start;
  }

  const out: RemappedSegment[] = [];
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text || seg.end <= seg.start) continue;

    let mappedStart: number | null = null;
    let mappedEnd: number | null = null;
    let sourceAnchor = seg.sourceStart ?? seg.start;

    for (const k of keepOffsets) {
      if (k.end <= seg.start) continue;
      if (k.start >= seg.end) break;
      const ovStart = Math.max(seg.start, k.start);
      const ovEnd = Math.min(seg.end, k.end);
      if (ovEnd - ovStart < 0.02) continue;

      const outS = k.outStart + (ovStart - k.start);
      const outE = k.outStart + (ovEnd - k.start);
      if (mappedStart === null) {
        mappedStart = outS;
        sourceAnchor = ovStart;
      }
      mappedEnd = outE;
    }

    if (mappedStart !== null && mappedEnd !== null && mappedEnd > mappedStart) {
      out.push({
        start: mappedStart,
        end: mappedEnd,
        sourceStart: sourceAnchor,
        text,
      });
    }
  }
  return out;
}

export function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`;
}

export function formatSrt(segments: { start: number; end: number; text: string }[]): string {
  return segments
    .filter((s) => s.text.trim().length > 0 && s.end > s.start)
    .map(
      (s, i) =>
        `${i + 1}\n${formatSrtTime(s.start)} --> ${formatSrtTime(s.end)}\n${s.text.trim()}\n`,
    )
    .join("\n");
}

export function formatTimestampShort(seconds: number): string {
  const totalSec = Math.max(0, Math.floor(seconds));
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

export function formatTranscriptForAi(
  segments: { start: number; text: string }[],
  maxLines = 180,
): string {
  const sliced = segments.slice(0, maxLines);
  const lines = sliced.map((s) => `[${formatTimestampShort(s.start)}] ${s.text}`);
  if (segments.length > maxLines) {
    lines.push(`... (${segments.length - maxLines} more lines omitted)`);
  }
  return lines.join("\n");
}

export function parseChunkTranscriptJson(raw: string, chunkDuration: number): { start: number; end: number; text: string }[] {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates = [cleaned];
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const lb = cleaned.indexOf("{");
  const rb = cleaned.lastIndexOf("}");
  if (lb !== -1 && rb > lb) candidates.push(cleaned.slice(lb, rb + 1));
  const la = cleaned.indexOf("[");
  const ra = cleaned.lastIndexOf("]");
  if (la !== -1 && ra > la) candidates.push(cleaned.slice(la, ra + 1));

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { segments?: unknown }).segments)
          ? (parsed as { segments: unknown[] }).segments
          : null;
      if (arr) {
        const out: { start: number; end: number; text: string }[] = [];
        for (const item of arr) {
          if (!item || typeof item !== "object") continue;
          const rec = item as Record<string, unknown>;
          const text = typeof rec.text === "string" ? rec.text.trim() : "";
          const s = Number(rec.start);
          const e = Number(rec.end);
          if (!text || !Number.isFinite(s) || !Number.isFinite(e)) continue;
          const clampedS = Math.max(0, Math.min(chunkDuration, s));
          const clampedE = Math.max(clampedS + 0.1, Math.min(chunkDuration, e));
          out.push({ start: clampedS, end: clampedE, text });
        }
        if (out.length > 0) return out;
      }
    } catch {
      /* try next candidate */
    }
  }

  // Graceful fallback: if model returned plain text, place it across the chunk.
  if (cleaned) {
    return [{ start: 0, end: Math.max(0.5, chunkDuration), text: cleaned }];
  }
  return [];
}

/// Transcribe a single cut audio chunk using `agy` (Gemini audio-capable model)
/// via cli2api + Smart Model Orchestrator (with auto-fallback & quota protection).
export async function transcribeAudioChunkViaAgy(opts: {
  baseUrl: string;
  apiKey?: string;
  preferredModel?: string;
  autoSwitch?: boolean;
  minDelayMs?: number;
  chunk: AudioChunk;
  language: string;
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
}): Promise<{ segments: TranscriptSegment[]; modelUsed: string }> {
  const chunkDur = Math.max(0.5, opts.chunk.timeline_end - opts.chunk.timeline_start);
  const langInstruction =
    opts.language === "fa"
      ? "The speaker is speaking Persian (فارسی). Transcribe accurately in natural Persian script."
      : opts.language === "en"
        ? "The speaker is speaking English. Transcribe accurately in English."
        : "Detect the spoken language automatically (likely Persian or English) and transcribe accurately in its native script.";

  const res = await orchestratedChatCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    task: "audio_transcribe",
    preferredModel: opts.preferredModel,
    autoSwitch: opts.autoSwitch,
    minDelayMs: opts.minDelayMs ?? 3200,
    responseFormatJson: true,
    signal: opts.signal,
    onStatus: opts.onStatus,
    messages: [
      {
        role: "system",
        content: `You are a precision speech-to-text subtitle engine.
Read the audio file using your file-reading tool and transcribe every spoken phrase into short subtitle segments (4 to 10 words per line, ideal for YouTube subtitles).
${langInstruction}
Timestamps MUST be relative to the start of this audio file (0.0 to ${chunkDur.toFixed(2)} seconds).
Return STRICT JSON ONLY:
{"segments":[{"start":0.0,"end":2.8,"text":"..."}]}`,
      },
      {
        role: "user",
        content: `Read and transcribe the audio file at path: ${opts.chunk.path} (relative path: ${opts.chunk.rel_path}). Duration is ${chunkDur.toFixed(2)}s. Return JSON {"segments":[...]}.`,
      },
    ],
  });

  const localSegs = parseChunkTranscriptJson(res.content, chunkDur);
  const mapped: TranscriptSegment[] = localSegs.map((s) => ({
    start: Number((opts.chunk.timeline_start + s.start).toFixed(3)),
    end: Number((opts.chunk.timeline_start + s.end).toFixed(3)),
    sourceStart: Number((opts.chunk.source_start + s.start).toFixed(3)),
    text: s.text,
  }));

  return { segments: mapped, modelUsed: res.modelUsed };
}

export async function generateYoutubeChapters(opts: {
  baseUrl: string;
  apiKey?: string;
  preferredModel?: string;
  autoSwitch?: boolean;
  segments: { start: number; text: string }[];
  language?: string;
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
}): Promise<{ text: string; modelUsed: string }> {
  const transcript = formatTranscriptForAi(opts.segments);
  const langHint = opts.language === "en" ? "English" : "Persian (فارسی)";
  const res = await orchestratedChatCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    task: "chapters",
    preferredModel: opts.preferredModel,
    autoSwitch: opts.autoSwitch,
    signal: opts.signal,
    onStatus: opts.onStatus,
    messages: [
      {
        role: "system",
        content: `You create clean, accurate YouTube Chapters (timestamps) from a video transcript.
Rules:
- Start the first chapter at 00:00.
- Use timestamps that actually appear in the transcript (format MM:SS or H:MM:SS).
- Write short, engaging chapter titles in ${langHint}.
- Output ONLY the chapter lines (no intro, no markdown fences, no extra commentary).`,
      },
      {
        role: "user",
        content: `Create YouTube chapters for this post-cut video transcript:\n\n${transcript}`,
      },
    ],
  });
  return {
    text: res.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
    modelUsed: res.modelUsed,
  };
}

export async function generateYoutubeMetadata(opts: {
  baseUrl: string;
  apiKey?: string;
  preferredModel?: string;
  autoSwitch?: boolean;
  segments: { start: number; text: string }[];
  language?: string;
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
}): Promise<{ text: string; modelUsed: string }> {
  const transcript = formatTranscriptForAi(opts.segments);
  const langHint = opts.language === "en" ? "English" : "Persian (فارسی)";
  const res = await orchestratedChatCompletion({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    task: "metadata",
    preferredModel: opts.preferredModel,
    autoSwitch: opts.autoSwitch,
    signal: opts.signal,
    onStatus: opts.onStatus,
    messages: [
      {
        role: "system",
        content: `You are a YouTube growth strategist. Given a video transcript, write ready-to-publish YouTube metadata in ${langHint}:
1. 3 clickable Title ideas
2. A concise, SEO-friendly Description (2-3 short paragraphs)
3. 10-15 comma-separated Tags
Keep it crisp and ready to copy-paste.`,
      },
      {
        role: "user",
        content: `Generate YouTube title ideas, description, and tags for this transcript:\n\n${transcript}`,
      },
    ],
  });
  return {
    text: res.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
    modelUsed: res.modelUsed,
  };
}
