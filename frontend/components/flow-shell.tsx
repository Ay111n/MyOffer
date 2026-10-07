"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { BrandLogo, BrandMark } from "./brand";
import { ReportExport, ReportRestore } from "./report-tools";
import { Button } from "./ui";
import { usePreferences } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { requestComparisonScroll } from "@/lib/use-comparison-scroll";
import { useFlowStore } from "@/stores/flow-store";

type StepState = "done" | "current" | "todo";

/** 当前这次比较的三步：填写 → 偏好 → 报告。
 *  步骤只是定位与跳转，不改变任何流程规则（报告是否可出仍由后端决定）。 */
function ComparisonSteps({ pathname, sessionId }: { pathname: string; sessionId: string | null }) {
  const { data: prefs } = usePreferences(sessionId);
  const preference = prefs?.data;
  const onResults = pathname.startsWith("/results");
  const steps: { key: string; label: string; short: string; href: string; state: StepState }[] = [
    { key: "offers", label: "填写 Offer", short: "填写", href: "/#offers", state: onResults ? "done" : "current" },
    { key: "preferences", label: "你的偏好", short: "偏好", href: "/#preferences", state: onResults || preference ? "done" : "todo" },
    { key: "report", label: "对比报告", short: "报告", href: "/results", state: onResults ? "current" : "todo" },
  ];
  return (
    <nav aria-label="比较进度" className="no-print border-t border-hairline">
      <ol className="mx-auto flex max-w-6xl items-stretch px-4 sm:px-6">
        {steps.map((step, index) => (
          <li key={step.key} className="min-w-0 flex-1 sm:flex-none">
            <Link
              href={step.href}
              scroll={step.key === "report"}
              onNavigate={() => {
                if (step.key === "offers" || step.key === "preferences") requestComparisonScroll(step.key);
              }}
              aria-current={step.state === "current" ? "step" : undefined}
              className={cn(
                "flex h-11 items-center gap-2 border-b-2 pr-5 text-sm transition-colors sm:pr-8",
                step.state === "current"
                  ? "border-blue-700 font-semibold text-ink"
                  : "border-transparent text-slate-500 hover:text-ink",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
                  step.state === "done" && "bg-blue-700 text-white",
                  step.state === "current" && "bg-ink text-white",
                  step.state === "todo" && "border border-slate-300 text-slate-500",
                )}
              >
                {step.state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : index + 1}
              </span>
              <span className="truncate">
                <span className="sm:hidden">{step.short}</span>
                <span className="hidden sm:inline">{step.label}</span>
              </span>
              {step.state === "done" && <span className="sr-only">（已完成）</span>}
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function FlowShell({ children }: { children: React.ReactNode }) {
  const sessionId = useFlowStore((state) => state.sessionId);
  const pathname = usePathname();
  const showSteps = pathname === "/" || pathname === "/complete" || pathname.startsWith("/results");
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hairline bg-paper/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
          <Link href="/" aria-label="MyOffer · 返回首页" className="flex shrink-0 items-center">
            <BrandLogo />
          </Link>
          <div className="flex items-center gap-4 sm:gap-6">
            <Link href="/settings/models" className="text-sm font-medium text-slate-600 hover:text-ink">模型配置</Link>
            <ReportRestore />
            <ReportExport sessionId={sessionId ?? ""} />
          </div>
        </div>
        {showSteps && <ComparisonSteps pathname={pathname} sessionId={sessionId} />}
      </header>
      <main id="main-content" className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6 sm:pt-12">{children}</main>
    </div>
  );
}

export function NeedSession() {
  const router = useRouter();
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <BrandMark className="mx-auto h-12 w-12" />
      <h1 className="mt-6 text-xl font-semibold tracking-tight text-ink">还没有可查看的结果</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">
        先填写 Offer 信息并生成对比报告，结论会出现在这里。
      </p>
      <Button className="mt-6" variant="accent" onClick={() => router.push("/")}>去填写 Offer</Button>
    </div>
  );
}
