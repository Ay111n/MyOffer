"use client";

import { useEffect } from "react";
import { Button, Card } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-16">
      <Card className="text-center">
        <p className="text-[14px] font-semibold uppercase tracking-[0.24em] text-neutral-500">出错了</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-0.01em] text-neutral-950">页面加载出现问题</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-500">
          请重试；若持续失败，请刷新页面或返回首页。
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button onClick={reset}>重试</Button>
          <Button variant="ghost" onClick={() => { window.location.href = "/"; }}>返回首页</Button>
        </div>
      </Card>
    </div>
  );
}
