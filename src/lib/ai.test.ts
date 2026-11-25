import { describe, expect, it } from "vitest";
import { applyAiActions, parseAiResponse, pickPreferredModel } from "./ai";

const baseState = {
  duration: 60,
  params: {
    threshold: 0.5,
    min_silence_ms: 100,
    min_speech_ms: 150,
    pad: 0.3,
    source_offset: 0,
  },
  keeps: [
    { start: 2, end: 10, disabled: false },
    { start: 12, end: 12.6, disabled: false },
    { start: 13, end: 25, disabled: false },
    { start: 40, end: 58, disabled: false },
  ],
  exportOptions: {
    quality: "medium" as const,
    resolution: "source" as const,
  },
};

describe("parseAiResponse", () => {
  it("parses plain JSON responses", () => {
    const res = parseAiResponse(
      JSON.stringify({
        reply: "Trimmed 5s from start",
        actions: [{ type: "trim_edges", cut_start: 5 }],
      }),
    );
    expect(res.reply).toBe("Trimmed 5s from start");
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0].type).toBe("trim_edges");
  });

  it("extracts JSON wrapped in think blocks and markdown fences", () => {
    const raw = `<think>calculating cuts</think>
Here you go:
\`\`\`json
{"reply":"Done","actions":[{"type":"detect_silences"}]}
\`\`\``;
    const res = parseAiResponse(raw);
    expect(res.reply).toBe("Done");
    expect(res.actions).toEqual([{ type: "detect_silences" }]);
  });

  it("falls back to plain text when JSON is absent", () => {
    const res = parseAiResponse("Just a regular explanation.");
    expect(res.reply).toBe("Just a regular explanation.");
    expect(res.actions).toEqual([]);
  });
});

describe("pickPreferredModel", () => {
  it("prefers agy when available", () => {
    expect(pickPreferredModel(["claude", "agy", "codex"])).toBe("agy");
  });

  it("keeps current model if still present", () => {
    expect(pickPreferredModel(["claude", "agy"], "claude")).toBe("claude");
  });
});

describe("applyAiActions", () => {
  it("trims edges across existing keeps", () => {
    const out = applyAiActions(
      [{ type: "trim_edges", cut_start: 5, cut_end: 5 }],
      baseState,
    );
    expect(out.nextKeeps).toEqual([
      { start: 5, end: 10, disabled: false },
      { start: 12, end: 12.6, disabled: false },
      { start: 13, end: 25, disabled: false },
      { start: 40, end: 55, disabled: false },
    ]);
  });

  it("splits a keep when removing a range inside it", () => {
    const out = applyAiActions(
      [{ type: "remove_range", start: 15, end: 20 }],
      baseState,
    );
    expect(out.nextKeeps).toEqual([
      { start: 2, end: 10, disabled: false },
      { start: 12, end: 12.6, disabled: false },
      { start: 13, end: 15, disabled: false },
      { start: 20, end: 25, disabled: false },
      { start: 40, end: 58, disabled: false },
    ]);
  });

  it("filters short keeps and merges close keeps", () => {
    const out = applyAiActions(
      [
        { type: "filter_short_keeps", min_duration: 1.0 },
        { type: "merge_close_keeps", max_gap: 3.5 },
      ],
      baseState,
    );
    expect(out.nextKeeps).toEqual([
      { start: 2, end: 25, disabled: false },
      { start: 40, end: 58, disabled: false },
    ]);
  });

  it("disables and re-enables keeps by 1-based index", () => {
    const out = applyAiActions(
      [{ type: "disable_keeps", indices: [1, 4] }],
      baseState,
    );
    expect(out.nextKeeps?.[0].disabled).toBe(true);
    expect(out.nextKeeps?.[1].disabled).toBe(false);
    expect(out.nextKeeps?.[3].disabled).toBe(true);
  });

  it("clamps detection params and updates export options", () => {
    const out = applyAiActions(
      [
        { type: "set_params", threshold: 0.75, pad: 0.1, run_detect: true },
        { type: "set_export_options", quality: "high", resolution: "1080p" },
      ],
      baseState,
    );
    expect(out.paramsChanged).toBe(true);
    expect(out.triggerDetect).toBe(true);
    expect(out.nextParams.threshold).toBe(0.75);
    expect(out.nextParams.pad).toBe(0.1);
    expect(out.exportOptionsChanged).toBe(true);
    expect(out.nextExportOptions).toEqual({ quality: "high", resolution: "1080p" });
  });
});
