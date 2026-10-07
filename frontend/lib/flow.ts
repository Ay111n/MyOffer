/**
 * 会话阶段模型 + path 映射（v0.6 两环节）。
 *
 * 服务端 phase：
 *   completion ──POST questions/stop──► results
 *   results 阶段的任何写入自动回退 completion（reopen）。
 * 会话创建即进入 completion（默认携带 Offer A / Offer B 两张候选项）。
 *
 * 本文件是 phase → 路由的唯一出处；页面跳转都从这里拿路径，
 * 禁止散落的字面量。
 */

export type Phase = "completion" | "results";

export const PHASE_ORDER: readonly Phase[] = [
  "completion",
  "results",
] as const;

const PHASE_TO_PATH: Record<Phase, string> = {
  completion: "/",
  results: "/results",
};

const PATH_TO_PHASE: Record<string, Phase> = Object.fromEntries(
  [
    ...Object.entries(PHASE_TO_PATH).map(([phase, path]) => [path, phase as Phase]),
    // 旧入口仍可直接打开，但不再作为 completion 的规范路径。
    ["/complete", "completion"],
  ],
) as Record<string, Phase>;

export const PHASE_LABELS: Record<Phase, string> = {
  completion: "信息补全中",
  results: "结果已生成",
};

export function phaseLabel(phase: string | null | undefined): string {
  return (phase && PHASE_LABELS[phase as Phase]) || phase || "";
}

/** phase → 规范路径；未知 phase 返回 null（调用方决定如何兜底，不再静默）。 */
export function pathForPhase(phase: string | null | undefined): string | null {
  if (!phase) return null;
  return PHASE_TO_PATH[phase as Phase] ?? null;
}

/** 路径 → phase；未知路径返回 null。 */
export function phaseForPath(path: string): Phase | null {
  return PATH_TO_PHASE[path] ?? null;
}

/**
 * 给定当前 phase，返回主按钮应跳的路径。
 *  - completion：去结果对比
 *  - results：已是终点
 */
export function nextPathFromPhase(phase: string | null | undefined): string | null {
  switch (phase as Phase) {
    case "completion":
      return PHASE_TO_PATH.results;
    default:
      return null;
  }
}
