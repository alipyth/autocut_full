import { beforeEach, describe, expect, it } from "vitest";
import {
  buildCandidateChain,
  clearModelCooldowns,
  isAudioCapableModel,
  isQuotaOrRateLimitError,
  markModelCooldown,
} from "./orchestrator";

describe("orchestrator model routing", () => {
  beforeEach(() => {
    clearModelCooldowns();
  });

  it("identifies audio-capable Gemini models and rejects text-only models", () => {
    expect(isAudioCapableModel("agy/gemini-3.8-flash-low")).toBe(true);
    expect(isAudioCapableModel("agy/gemini-4-neon-medium")).toBe(true);
    expect(isAudioCapableModel("agy")).toBe(true);
    expect(isAudioCapableModel("agy/claude-sonnet-5-5-medium")).toBe(false);
    expect(isAudioCapableModel("claude")).toBe(false);
    expect(isAudioCapableModel("codex")).toBe(false);
  });

  it("never puts Claude or Codex in the audio_transcribe chain even if preferred", () => {
    const chain = buildCandidateChain("audio_transcribe", "agy/claude-sonnet-5-5-medium");
    expect(chain.every((m) => isAudioCapableModel(m))).toBe(true);
    expect(chain[0]).toBe("agy/gemini-3.8-flash-low");
  });

  it("moves cooled-down models to the tail of the fallback chain", () => {
    const now = 1_000_000;
    markModelCooldown("agy/gemini-3.8-flash-low", 60_000, now);
    const chain = buildCandidateChain("audio_transcribe", "agy/gemini-3.8-flash-low", now + 1000);
    expect(chain[0]).toBe("agy/gemini-3.8-flash-medium");
    expect(chain[chain.length - 1]).toBe("agy/gemini-3.8-flash-low");
  });

  it("detects quota, 429, and capacity errors", () => {
    expect(isQuotaOrRateLimitError(429, "")).toBe(true);
    expect(isQuotaOrRateLimitError(503, "")).toBe(true);
    expect(isQuotaOrRateLimitError(500, "RESOURCE_EXHAUSTED: quota exceeded")).toBe(true);
    expect(isQuotaOrRateLimitError(400, "invalid JSON")).toBe(false);
  });
});
