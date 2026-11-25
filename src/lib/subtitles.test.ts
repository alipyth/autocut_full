import { describe, expect, it } from "vitest";
import {
  formatSrt,
  formatSrtTime,
  formatTimestampShort,
  remapSegmentsToCutlist,
  sourceTimeToExportTime,
} from "./subtitles";

describe("formatSrtTime & formatTimestampShort", () => {
  it("formats SRT timestamps accurately", () => {
    expect(formatSrtTime(0)).toBe("00:00:00,000");
    expect(formatSrtTime(65.432)).toBe("00:01:05,432");
    expect(formatSrtTime(3661.5)).toBe("01:01:01,500");
  });

  it("formats YouTube chapter timestamps", () => {
    expect(formatTimestampShort(0)).toBe("00:00");
    expect(formatTimestampShort(75)).toBe("01:15");
    expect(formatTimestampShort(3665)).toBe("1:01:05");
  });
});

describe("remapSegmentsToCutlist", () => {
  it("remaps segments across kept intervals and drops cut silences", () => {
    // Source: keep [2..10] (8s), remove [10..15] (5s silence), keep [15..25] (10s)
    const keeps = [
      { start: 2, end: 10, disabled: false },
      { start: 15, end: 25, disabled: false },
    ];
    const segments = [
      { start: 3, end: 6, text: "سلام رفقا" },
      { start: 11, end: 14, text: "سکوت حذف شده" },
      { start: 16, end: 20, text: "بخش دوم آموزش" },
    ];

    const remapped = remapSegmentsToCutlist(segments, keeps);
    expect(remapped).toHaveLength(2);
    expect(remapped[0]).toEqual({
      start: 1,
      end: 4,
      sourceStart: 3,
      text: "سلام رفقا",
    });
    expect(remapped[1]).toEqual({
      start: 9,
      end: 13,
      sourceStart: 16,
      text: "بخش دوم آموزش",
    });
  });

  it("produces valid SRT output", () => {
    const srt = formatSrt([
      { start: 0.5, end: 2.25, text: "خط اول" },
      { start: 3, end: 5, text: "خط دوم" },
    ]);
    expect(srt).toContain("1\n00:00:00,500 --> 00:00:02,250\nخط اول\n");
    expect(srt).toContain("2\n00:00:03,000 --> 00:00:05,000\nخط دوم\n");
  });

  it("maps source preview time to post-cut export time", () => {
    const keeps = [
      { start: 2, end: 10, disabled: false },
      { start: 15, end: 25, disabled: false },
    ];
    expect(sourceTimeToExportTime(1, keeps)).toBe(0);
    expect(sourceTimeToExportTime(5, keeps)).toBe(3);
    expect(sourceTimeToExportTime(12, keeps)).toBe(8);
    expect(sourceTimeToExportTime(17, keeps)).toBe(10);
  });
});
