"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DetailEmpty, DetailFrame, DetailGate, OfferSwitch, OfferTitle } from "@/components/detail-parts";
import { useResult } from "@/lib/api/hooks";
import { useFlowStore, useHydrateSession } from "@/stores/flow-store";
import { fmtMoney, offerColor } from "@/lib/constants";

export default function SalaryDetailPage() {
  const router = useRouter();
  const sessionId = useFlowStore((s) => s.sessionId);
  useHydrateSession();
  const { data: view, isLoading, error } = useResult(sessionId);
  const [selected, setSelected] = useState<number | null>(null);

  const columns = (view?.offers ?? []).slice().sort((a, b) => a.display_order - b.display_order);
  // selected 为 null 时回退到第一个 Offer（tab 高亮与内容共用 active）
  const active = columns.find((o) => o.display_order === selected) ?? columns[0];

  const gate = DetailGate({ sessionId, loading: isLoading });
  if (gate) return gate;
  // 只在确实没有数据时展示空态：后台重取失败时 React Query 会保留旧 data
  // 并同时置 error——曾把这种瞬时失败渲染成「没有计算结果」误导用户
  if (!view || columns.length === 0) {
    return <DetailEmpty title="每月到手工资" error={error} onGo={() => router.push("/")} />;
  }

  const rows = active?.salary.monthly_rows ?? [];
  const annualPre = rows.reduce((s, r) => s + r.tax_pre, 0);
  const annualTax = rows.reduce((s, r) => s + r.tax, 0);
  const annualAfter = rows.reduce((s, r) => s + r.after_tax, 0);
  const maxPre = Math.max(1, ...rows.map((r) => r.tax_pre));
  const color = active ? offerColor(active.display_order) : "#2a665a";

  return (
    <DetailFrame
      eyebrow="对比报告 / 薪资明细"
      title="每月到手工资"
      lede="固定工资与现金补贴按固定薪数摊入 12 个月的估算明细，不代表实际发薪时间表。年度奖金与入职收入在报告中单列。"
      error={error}
    >
      <OfferSwitch offers={columns} active={active?.display_order} onSelect={setSelected} />

      {active && (
        <section aria-label={`Offer ${String.fromCharCode(64 + active.display_order)} 薪资明细`} className="pt-8">
          <OfferTitle order={active.display_order} company={active.company} />

          <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
            {[
              ["全年到手", annualAfter, true],
              ["全年税前", annualPre, false],
              ["全年个税", annualTax, false],
            ].map(([label, value, strong]) => (
              <div key={String(label)} className="border-t border-hairline pt-3">
                <dt className="text-xs text-slate-500">{String(label)}</dt>
                <dd className="metric mt-1 text-2xl" style={strong ? { color } : undefined}>
                  {rows.length ? `¥${fmtMoney(Number(value))}` : "—"}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 overflow-x-auto">
            <table className="detail-table w-full text-sm">
              <caption className="pb-3 text-left text-xs text-slate-500">
                每月到手工资（累计预扣法 · 1–12 月）。每行的条形：深色是到手，浅色是个税，整条是税前。
              </caption>
              <thead>
                <tr className="border-b border-ink text-xs text-slate-500">
                  <th scope="col" className="py-2 pr-3 text-left font-medium">月份</th>
                  <th scope="col" className="w-full min-w-[8rem] px-3 py-2 text-left font-medium max-sm:hidden"><span className="sr-only">构成</span></th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">税前</th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">个税</th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">税后</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={5} className="py-8 text-center text-slate-500">薪酬信息未填写完整，暂无法生成月度明细。</td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.month} className="border-b border-hairline">
                    <th scope="row" className="py-2.5 pr-3 text-left font-medium">{r.month} 月</th>
                    <td className="px-3 py-2.5 max-sm:hidden">
                      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-sm bg-slate-100" style={{ width: `${(r.tax_pre / maxPre) * 100}%` }}>
                        <span style={{ width: `${r.tax_pre > 0 ? (r.after_tax / r.tax_pre) * 100 : 0}%`, backgroundColor: color }} />
                        <span className="flex-1 bg-slate-300" />
                      </div>
                    </td>
                    <td className="num py-2.5 pl-3 text-right">{fmtMoney(r.tax_pre)}</td>
                    <td className="num py-2.5 pl-3 text-right text-slate-500">{fmtMoney(r.tax)}</td>
                    <td className="num py-2.5 pl-3 text-right font-semibold" style={{ color }}>{fmtMoney(r.after_tax)}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" className="py-3 pr-3 text-left">全年</th>
                    <td className="max-sm:hidden" />
                    <td className="num py-3 pl-3 text-right">{fmtMoney(annualPre)}</td>
                    <td className="num py-3 pl-3 text-right">{fmtMoney(annualTax)}</td>
                    <td className="num py-3 pl-3 text-right" style={{ color }}>{fmtMoney(annualAfter)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            个税采用累计预扣法，税率随累计收入递增，所以年底几个月到手会略少；到手 = 税前 − 个税 − 个人五险一金。
          </p>
        </section>
      )}
    </DetailFrame>
  );
}
