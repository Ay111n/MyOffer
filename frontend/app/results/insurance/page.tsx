"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DetailEmpty, DetailFrame, DetailGate, OfferSwitch, OfferTitle } from "@/components/detail-parts";
import { useResult } from "@/lib/api/hooks";
import { useFlowStore, useHydrateSession } from "@/stores/flow-store";
import { INSURANCE_SEG_COLORS, fmtMoney } from "@/lib/constants";

export default function InsuranceDetailPage() {
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
    return <DetailEmpty title="五险一金明细" error={error} onGo={() => router.push("/")} />;
  }

  const items = active?.insurance.items ?? [];
  const personalTotal = items.reduce((s, i) => s + i.personal, 0);
  const employerTotal = items.reduce((s, i) => s + i.employer, 0);
  const maxRow = Math.max(1, ...items.map((i) => i.personal + i.employer));

  return (
    <DetailFrame
      eyebrow="对比报告 / 缴纳明细"
      title="五险一金明细"
      lede="个人缴纳与单位缴纳分开列示，金额均为每月参考值。个人部分会从你的到手工资里扣掉，单位部分是公司另外出的钱。"
      error={error}
    >
      <OfferSwitch offers={columns} active={active?.display_order} onSelect={setSelected} />

      {active && (
        <section aria-label={`Offer ${String.fromCharCode(64 + active.display_order)} 五险一金明细`} className="pt-8">
          <OfferTitle order={active.display_order} company={active.company} />

          <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
            {[
              ["个人每月缴纳", personalTotal, INSURANCE_SEG_COLORS.personal],
              ["单位每月缴纳", employerTotal, undefined],
              ["单位 / 个人", null, undefined],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="border-t border-hairline pt-3">
                <dt className="text-xs text-slate-500">{String(label)}</dt>
                <dd className="metric mt-1 text-2xl" style={color ? { color: String(color) } : undefined}>
                  {items.length === 0 ? "—"
                    : value === null ? (personalTotal > 0 ? `${(employerTotal / personalTotal).toFixed(1)} 倍` : "—")
                      : `¥${fmtMoney(Number(value))}`}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 overflow-x-auto">
            <table className="detail-table w-full text-sm">
              <caption className="pb-3 text-left text-xs text-slate-500">
                每月五险一金缴纳明细（元）。条形：深色是个人缴纳，浅色是单位缴纳。
              </caption>
              <thead>
                <tr className="border-b border-ink text-xs text-slate-500">
                  <th scope="col" className="py-2 pr-3 text-left font-medium">项目</th>
                  <th scope="col" className="w-full min-w-[8rem] px-3 py-2 text-left font-medium max-sm:hidden"><span className="sr-only">构成</span></th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">个人缴纳</th>
                  <th scope="col" className="py-2 pl-3 text-right font-medium">单位缴纳</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr><td colSpan={4} className="py-8 text-center text-slate-500">五险一金信息未填写完整。</td></tr>
                )}
                {items.map((i) => (
                  <tr key={i.item} className="border-b border-hairline">
                    <th scope="row" className="py-2.5 pr-3 text-left font-medium">{i.item}</th>
                    <td className="px-3 py-2.5 max-sm:hidden">
                      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-sm" style={{ width: `${((i.personal + i.employer) / maxRow) * 100}%` }}>
                        <span style={{ flexGrow: i.personal, backgroundColor: INSURANCE_SEG_COLORS.personal }} />
                        <span style={{ flexGrow: i.employer, backgroundColor: INSURANCE_SEG_COLORS.employer }} />
                      </div>
                    </td>
                    <td className="num py-2.5 pl-3 text-right">{fmtMoney(i.personal)}</td>
                    <td className="num py-2.5 pl-3 text-right">{fmtMoney(i.employer)}</td>
                  </tr>
                ))}
              </tbody>
              {items.length > 0 && (
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" className="py-3 pr-3 text-left">合计</th>
                    <td className="max-sm:hidden" />
                    <td className="num py-3 pl-3 text-right">{fmtMoney(personalTotal)}</td>
                    <td className="num py-3 pl-3 text-right">{fmtMoney(employerTotal)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            个人缴纳仅含医疗 / 养老 / 失业 / 公积金，生育与工伤由单位承担；公积金费率取自你填报的比例。
          </p>
        </section>
      )}
    </DetailFrame>
  );
}
