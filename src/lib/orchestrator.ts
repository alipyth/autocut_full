// Smart Model Orchestrator for cli2api + agy.
//
// - Routes audio transcription ONLY to audio-capable Gemini models (never Claude/Codex).
// - Enforces gentle inter-request pacing + jitter to avoid rate limits / bans.
// - Automatically switches to the next Gemini model on quota / 429 / capacity errors
//   and puts the limited model into a 90s cooldown.

export type OrchestratorTask = "audio_transcribe" | "chat_edit" | "chapters" | "metadata";

/// Gemini models available in `agy` that natively understand audio files,
/// ordered from lightest/fastest quota to stronger fallbacks.
export const AUDIO_MODEL_CHAIN: string[] = [
  "agy/gemini-3.8-flash-low",
  "agy/gemini-3.8-flash-medium",
  "agy/gemini-3.8-flash-high",
  "agy/gemini-4-neon-low",
  "agy/gemini-4-neon-medium",
  "agy/gemini-4-carbon-low",
  "agy/gemini-4-argon-low",
  "agy/gemini-4-hydrogen-low",
  "agy",
];

/// Text/reasoning models for editing commands, YouTube chapters, and metadata.
export const TEXT_MODEL_CHAIN: string[] = [
  "agy/gemini-3.8-flash-medium",
  "agy/gemini-4-neon-medium",
  "agy/gemini-4-carbon-medium",
  "agy/gemini-4-argon-medium",
  "agy/claude-sonnet-5-5-medium",
  "agy",
  "claude",
  "codex",
];

export const ALL_PRESET_MODELS: { id: string; label: string; audio: boolean }[] = [
  { id: "agy/gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low · Audio · کم‌مصرف)", audio: true },
  { id: "agy/gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium · Audio)", audio: true },
  { id: "agy/gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High · Audio)", audio: true },
  { id: "agy/gemini-4-neon-low", label: "Gemini 4 Neon (Low · Audio)", audio: true },
  { id: "agy/gemini-4-neon-medium", label: "Gemini 4 Neon (Medium · Audio)", audio: true },
  { id: "agy/gemini-4-carbon-low", label: "Gemini 4 Carbon (Low · Audio)", audio: true },
  { id: "agy/gemini-4-argon-low", label: "Gemini 4 Argon (Low · Audio)", audio: true },
  { id: "agy/gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low · Audio)", audio: true },
  { id: "agy/claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Text only)", audio: false },
  { id: "agy/claude-opus-5-5-medium", label: "Claude Opus 5.5 (Text only)", audio: false },
  { id: "agy", label: "agy (Default)", audio: true },
  { id: "claude", label: "Claude CLI (Text only)", audio: false },
  { id: "codex", label: "Codex CLI (Text only)", audio: false },
];

export function isAudioCapableModel(modelId: string): boolean {
  const m = modelId.trim().toLowerCase();
  if (!m) return false;
  if (m === "agy" || m === "gemini") return true;
  if (m.includes("gemini")) return true;
  return false;
}

export function isQuotaOrRateLimitError(status: number, message: string): boolean {
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /quota|rate.?limit|too many requests|resource.?exhausted|capacity|overloaded|limit exceeded|try again|unavailable|timeout/i.test(
    message,
  );
}

const DEFAULT_COOLDOWN_MS = 90_000;
const cooldownMap = new Map<string, number>();
let lastRequestEndedAt = 0;

export function clearModelCooldowns() {
  cooldownMap.clear();
  lastRequestEndedAt = 0;
}

export function markModelCooldown(modelId: string, durationMs = DEFAULT_COOLDOWN_MS, now = Date.now()) {
  cooldownMap.set(modelId, now + durationMs);
}

export function isModelInCooldown(modelId: string, now = Date.now()): boolean {
  const until = cooldownMap.get(modelId);
  if (!until) return false;
  if (now >= until) {
    cooldownMap.delete(modelId);
    return false;
  }
  return true;
}

export function buildCandidateChain(
  task: OrchestratorTask,
  preferredModel?: string,
  now = Date.now(),
): string[] {
  const baseChain = task === "audio_transcribe" ? AUDIO_MODEL_CHAIN : TEXT_MODEL_CHAIN;
  const combined: string[] = [];

  if (preferredModel && preferredModel.trim()) {
    const pref = preferredModel.trim();
    if (task !== "audio_transcribe" || isAudioCapableModel(pref)) {
      combined.push(pref);
    }
  }
  for (const m of baseChain) {
    if (!combined.includes(m)) combined.push(m);
  }

  // Healthy (non-cooled-down) models first, cooled-down ones at the tail as last resort.
  const healthy = combined.filter((m) => !isModelInCooldown(m, now));
  const cooled = combined.filter((m) => isModelInCooldown(m, now));
  return [...healthy, ...cooled];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type OrchestratedResult = {
  content: string;
  modelUsed: string;
  switchedFrom?: string;
};

export async function orchestratedChatCompletion(opts: {
  baseUrl: string;
  apiKey?: string;
  task: OrchestratorTask;
  preferredModel?: string;
  autoSwitch?: boolean;
  minDelayMs?: number;
  responseFormatJson?: boolean;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
  onStatus?: (msg: string) => void;
}): Promise<OrchestratedResult> {
  const cleanUrl = opts.baseUrl.trim().replace(/\/+$/, "") || "http://localhost:8787/v1";
  const url = `${cleanUrl}/chat/completions`;
  const autoSwitch = opts.autoSwitch !== false;
  const minDelayMs = opts.minDelayMs ?? (opts.task === "audio_transcribe" ? 3000 : 1200);

  const candidates = buildCandidateChain(opts.task, opts.preferredModel);
  const attempts = autoSwitch ? candidates : candidates.slice(0, 1);

  // Enforce gentle pacing since last request to protect quota / avoid bans.
  const elapsed = Date.now() - lastRequestEndedAt;
  if (lastRequestEndedAt > 0 && elapsed < minDelayMs) {
    const jitter = Math.floor(Math.random() * 500);
    const waitMs = minDelayMs - elapsed + jitter;
    opts.onStatus?.(`محافظت کوتا: صبر ${(waitMs / 1000).toFixed(1)} ثانیه…`);
    await sleep(waitMs, opts.signal);
  }

  let firstTried: string | undefined;
  let lastError: Error = new Error("No models available");

  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    if (!firstTried) firstTried = model;

    opts.onStatus?.(
      i === 0
        ? `در حال ارسال به ${model}…`
        : `سوئیچ خودکار به ${model} (تلاش ${i + 1})…`,
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.apiKey?.trim()) {
      headers["Authorization"] = `Bearer ${opts.apiKey.trim()}`;
    }

    const body: Record<string, unknown> = {
      model,
      messages: opts.messages,
      timeout: opts.task === "audio_transcribe" ? 240 : 180,
    };
    if (opts.responseFormatJson) {
      body.response_format = { type: "json_object" };
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      lastRequestEndedAt = Date.now();

      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const errJson = (await res.json()) as {
            error?: { message?: string };
            detail?: string;
          };
          detail = errJson.error?.message ?? errJson.detail ?? detail;
        } catch {
          /* ignore */
        }

        lastError = new Error(`[${model}] ${detail}`);
        if (autoSwitch && i < attempts.length - 1 && isQuotaOrRateLimitError(res.status, detail)) {
          markModelCooldown(model);
          opts.onStatus?.(`مدل ${model} به لیمیت/خطا خورد — سوئیچ به مدل بعدی…`);
          await sleep(2500, opts.signal);
          continue;
        }
        throw lastError;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      return {
        content,
        modelUsed: model,
        switchedFrom: firstTried !== model ? firstTried : undefined,
      };
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      lastError = err instanceof Error ? err : new Error(msg);
      if (autoSwitch && i < attempts.length - 1 && isQuotaOrRateLimitError(0, msg)) {
        markModelCooldown(model);
        opts.onStatus?.(`مدل ${model} در دسترس نیست — سوئیچ به مدل بعدی…`);
        await sleep(2500, opts.signal);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}
