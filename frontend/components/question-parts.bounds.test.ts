import { describe, expect, it } from "vitest";
import { clampToFieldBounds, syncFieldBounds } from "@/components/question-parts";

describe("clampToFieldBounds", () => {
  it("超界派生值按字段声明上限钳制（回归：通勤 5h→300min 曾直发后端被 422 整单拒绝）", () => {
    expect(clampToFieldBounds("commute_minutes", 5 * 60)).toBe(240);
    expect(clampToFieldBounds("annual_bonus_months", 15)).toBe(12);
  });

  it("区间内的派生值原样保留", () => {
    expect(clampToFieldBounds("commute_minutes", 45)).toBe(45);
    expect(clampToFieldBounds("annual_bonus_months", 3)).toBe(3);
  });

  it("meta 未返回时按 FIELD_MAX 兜底，返回后按下发边界钳制", () => {
    expect(clampToFieldBounds("commute_minutes", 300)).toBe(240);
    syncFieldBounds({ commute_minutes: { min: 0, max: 120 } });
    expect(clampToFieldBounds("commute_minutes", 300)).toBe(120);
    syncFieldBounds(undefined);
  });

  it("无声明上限的字段不设上界、下限缺省 0（与后端数值字段默认下限一致）", () => {
    expect(clampToFieldBounds("annual_bonus_value", 1e9)).toBe(1e9);
    expect(clampToFieldBounds("weekly_work_hours", -3)).toBe(0);
  });
});
