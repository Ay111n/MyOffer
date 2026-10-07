"use client";

import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";

/**
 * 页面存在未保存内容时启用离开守卫：
 * - beforeunload 拦截浏览器刷新/关闭；
 * - popstate 拦截浏览器后退/前进（取消时推回当前页）。
 * 传入提示文案即启用，传 null（或卸载时）关闭。
 *
 * 程序化导航不需要守卫：草稿实时持久化到 sessionStorage（按会话+题目隔离），
 * 会话内跳转回来即恢复；跨会话跳转（如 404 回退首页）本就要丢弃旧工作区。
 */
export function useNavGuard(message: string | null) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!message) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [message]);

  // 浏览器后退/前进不经过 router.push，此前完全绕过守卫（移动端手势也是
  // 这条路径）。popstate 触发时 location 已切到目标页；用户取消则推回当前
  // 路由（草稿已持久化到 sessionStorage，重新渲染不丢内容）。
  useEffect(() => {
    if (!message) return;
    const onPopState = () => {
      if (window.confirm(`${message}\n未保存的内容将丢失，确定离开？`)) return;
      router.push(pathname);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [message, router, pathname]);
}
