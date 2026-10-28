import { describe, expect, it } from "vitest";
import {
  frameAt,
  frameCount,
  frameFromPts,
  frameSeekSeconds,
  frameTimestampMs,
  parseFrameRate,
  stepFrame,
} from "./frames";

const rates = {
  "30": { num: 30, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "23.976": { num: 24000, den: 1001 },
};

describe("frame indexing", () => {
  it("parses integer and fractional rates", () => {
    expect(parseFrameRate("30")).toEqual({ num: 30, den: 1 });
    expect(parseFrameRate("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFrameRate("0/0")).toBeNull();
    expect(parseFrameRate("abc")).toBeNull();
  });
  it("counts frames at integer and fractional rates", () => {
    expect(frameCount(20000, rates["30"])).toBe(600);
    expect(frameCount(20020, rates["29.97"])).toBe(600);
    expect(frameCount(10010, rates["23.976"])).toBe(240);
  });
  it.each(Object.entries(rates))(
    "round-trips every frame index at %s fps",
    (_, rate) => {
      const count = frameCount(20000, rate);
      for (let index = 0; index < count; index++) {
        expect(frameAt(frameTimestampMs(index, rate), rate, count)).toBe(index);
        expect(frameAt(frameSeekSeconds(index, rate) * 1000, rate, count)).toBe(
          index,
        );
      }
    },
  );
  it("maps 12 s to frame 360 at 30 fps and 359 at 29.97 fps", () => {
    expect(frameAt(12000, rates["30"], 600)).toBe(360);
    expect(frameAt(12000, rates["29.97"], 600)).toBe(359);
  });
  it("honours a start offset and clamps outside the media", () => {
    expect(frameAt(1000 + 100, rates["30"], 600, 1000)).toBe(3);
    expect(frameAt(-50, rates["30"], 600)).toBe(0);
    expect(frameAt(99999, rates["30"], 600)).toBe(599);
  });
  it("recovers the index from truncated presentation timestamps", () => {
    const rate = rates["29.97"];
    for (let index = 0; index < 600; index++) {
      const pts = (index * 1001) / 30; // ms
      expect(frameFromPts(Math.floor(pts * 1000) / 1000, rate, 600)).toBe(
        index,
      );
      expect(frameFromPts(pts - 0.001, rate, 600)).toBe(index);
    }
  });
  it("steps one frame at a time without leaving the media", () => {
    expect(stepFrame(10, 1, 600)).toBe(11);
    expect(stepFrame(0, -1, 600)).toBe(0);
    expect(stepFrame(599, 1, 600)).toBe(599);
    expect(stepFrame(5, -30, 600)).toBe(0);
  });
});
