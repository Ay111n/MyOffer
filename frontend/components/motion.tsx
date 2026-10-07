"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 滚动进入视口时一次性显现（上移 + 退模糊）。
 *
 * 刻意不用 JS 动画循环：显现由 CSS keyframes（合成器驱动）完成，
 * IntersectionObserver 只负责切换 class——即使 rAF 被节流
 * （内嵌 webview 空闲期、后台标签），内容也不会被卡在透明态。
 * SSR / 无 JS 环境直接可见，首屏内容不做入场动画。
 */
export function Reveal({
  children,
  delay = 0,
  className,
  as = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  /** 容器标签；在 <ul> 内做行级级联时传 "li"。 */
  as?: "div" | "li";
}) {
  const ref = useRef<HTMLElement | null>(null);
  // idle=保持服务端可见态；hidden=已挂载且在视口外；in=进入视口，播放显现
  const [phase, setPhase] = useState<"idle" | "hidden" | "in">("idle");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) return; // 首屏内容直接可见
    setPhase("hidden");
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPhase("in");
          io.disconnect();
        }
      },
      { rootMargin: "-40px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const Tag = as;
  return (
    <Tag
      // @ts-expect-error —— ref 跨 div/li 多态，回调 ref 在两者上签名一致
      ref={ref}
      className={cn(
        phase === "hidden" && "opacity-0",
        phase === "in" && "animate-fade-up",
        className,
      )}
      style={phase === "in" && delay > 0 ? { animationDelay: `${delay}s` } : undefined}
    >
      {children}
    </Tag>
  );
}

/** 统一页头：eyebrow（第 N 步）+ 大标题 + 右侧动作区，替代各页手写结构。 */
export function PageHeader({
  eyebrow,
  title,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div>
        {eyebrow && (
          <p className="text-[14px] font-semibold uppercase tracking-[0.18em] text-neutral-500">{eyebrow}</p>
        )}
        <h1 className="page-heading mt-2">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
