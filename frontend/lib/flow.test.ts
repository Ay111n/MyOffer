import { describe, expect, it } from "vitest";

import {
  nextPathFromPhase,
  pathForPhase,
  phaseForPath,
  phaseLabel,
} from "./flow";

describe("phase 模型（两环节，单源）", () => {
  it("phase → 规范路径一一对应", () => {
    expect(pathForPhase("completion")).toBe("/");
    expect(pathForPhase("results")).toBe("/results");
    expect(pathForPhase("unknown")).toBeNull();
    expect(pathForPhase(null)).toBeNull();
  });

  it("路径 → phase：根路径和旧入口都指向信息补全", () => {
    expect(phaseForPath("/complete")).toBe("completion");
    expect(phaseForPath("/results")).toBe("results");
    expect(phaseForPath("/")).toBe("completion");
    expect(phaseForPath("/offers")).toBeNull();
  });

  it("主按钮去向：completion → 结果对比；results 是终点", () => {
    expect(nextPathFromPhase("completion")).toBe("/results");
    expect(nextPathFromPhase("results")).toBeNull();
  });

  it("phase 标签：未知 phase 原样返回", () => {
    expect(phaseLabel("completion")).toBe("信息补全中");
    expect(phaseLabel("results")).toBe("结果已生成");
    expect(phaseLabel("whatever")).toBe("whatever");
    expect(phaseLabel(null)).toBe("");
  });
});
