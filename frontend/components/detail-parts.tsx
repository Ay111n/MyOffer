"use client";

/** 明细页（薪资 / 五险一金）共用的外框与 Offer 切换。 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NeedSession } from "@/components/flow-shell";
import { Button, Spinner } from "@/components/ui";
import { offerColor, offerHeading } from "@/lib/constants";
import { readApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

export function DetailFrame({
  eyebrow, title, lede, error, children,
}: { eyebrow: string; title: string; lede: string; error?: unknown; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/results" className="no-print -ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-ink">
        <ArrowLeft aria-hidden="true" className="h-4 w-4" />返回报告
      </Link>
      <header className="mt-2 border-b-2 border-ink pb-6">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="page-heading mt-2">{title}</h1>
        <p className="prose-cn mt-3 text-sm text-slate-600">{lede}</p>
      </header>
      {error ? (
        <p role="status" className="mt-4 rounded-lg border-l-2 border-amber-700 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          最新数据获取失败，以下为上次加载的结果：{readApiError(error)}
        </p>
      ) : null}
      {children}
    </div>
  );
}

export function DetailEmpty({ title, error, onGo }: { title: string; error: unknown; onGo: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        {readApiError(error, "还没有任何计算结果。先去填写 Offer 信息并生成报告。")}
      </p>
      <Button className="mt-5" variant="accent" onClick={onGo}>去填写 Offer</Button>
    </div>
  );
}

export function DetailGate({ sessionId, loading }: { sessionId: string | null; loading: boolean }) {
  if (!sessionId) return <NeedSession />;
  if (loading) return <Spinner />;
  return null;
}

type TabOffer = { offer_id: string; display_order: number };

/** 下划线式切换：字母徽章 + 当前项下划线，不再用整块反白按钮。 */
export function OfferSwitch({
  offers, active, onSelect,
}: { offers: TabOffer[]; active: number | undefined; onSelect: (order: number) => void }) {
  return (
    <div role="group" aria-label="明细 Offer 切换" className="no-print mt-6 flex flex-wrap gap-x-2 border-b border-hairline">
      {offers.map((offer) => {
        const current = offer.display_order === active;
        return (
          <button
            key={offer.offer_id}
            type="button"
            aria-pressed={current}
            onClick={() => onSelect(offer.display_order)}
            className={cn(
              "-mb-px flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm transition-colors",
              current ? "border-ink font-semibold text-ink" : "border-transparent text-slate-500 hover:text-ink",
            )}
          >
            <span
              aria-hidden="true"
              style={{ backgroundColor: offerColor(offer.display_order) }}
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] font-bold text-white"
            >
              {String.fromCharCode(64 + offer.display_order)}
            </span>
            Offer {String.fromCharCode(64 + offer.display_order)}
          </button>
        );
      })}
    </div>
  );
}

export function OfferTitle({ order, company }: { order: number; company: string }) {
  return <h2 className="section-title">{offerHeading(order, company)}</h2>;
}
