"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { phaseForPath } from "@/lib/flow";

/**
 * 路由转场：completion → results 视为前进（向上淡入），反向后退。
 * 刻意用 CSS 动画（合成器驱动）而非 JS 动画循环，避免 rAF 被节流时
 * 内容停留在透明态。
 */
function indexOf(pathname: string): number {
  const phase = phaseForPath(pathname);
  return phase === "results" ? 1 : 0;
}

// template 在每次导航时重挂载，组件 state 里的「上一次阶段」会随实例销毁
// 归零，方向判定永远是「前进」——后退动画分支成为死代码。模块级变量在
// SPA 导航间存活；整页加载时从 null 起步（与 SSR 输出一致，无 hydration 风险）。
let lastIndex: number | null = null;

export default function Template({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const index = indexOf(pathname);
  const dir = lastIndex === null || index === lastIndex
    ? 0
    : index > lastIndex ? 1 : -1;

  // 记录本次路由阶段，供下一次导航计算转场方向。
  useEffect(() => {
    lastIndex = index;
  }, [index]);

  return <div className={dir < 0 ? "animate-fade-down" : "animate-fade-up"}>{children}</div>;
}
