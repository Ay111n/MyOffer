"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { NeedSession } from "@/components/flow-shell";
import { ReportPrint } from "@/components/report-tools";
import { AiReportAnalysisProvider, AiReportSection } from "@/components/ai-report-analysis";
import { KeyNumbers, NextSteps, Reasons, Reliability, Scoreboard, Stability, VerdictHero } from "@/components/result-report";
import { Spinner } from "@/components/ui";
import { useResult } from "@/lib/api/hooks";
import type { OfferReportView } from "@/lib/api/types";
import { readApiError } from "@/lib/api/errors";
import { preferenceWeightSummary } from "@/lib/preference-questionnaire";

import { buildVerdict } from "@/lib/verdict";
import { useFlowStore, useHydrateSession } from "@/stores/flow-store";

const money = (value: number | null | undefined) => value == null ? "—" : `¥${Math.round(value).toLocaleString("zh-CN")}`;
const score = (value: number | null | undefined) => value == null ? "—" : value.toFixed(1);

function TaxInsuranceDialog({ offers }: { offers: OfferReportView[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selectedOfferId, setSelectedOfferId] = useState(offers[0]?.offer_id);
  const offer = offers.find((item) => item.offer_id === selectedOfferId) ?? offers[0];
  const estimated = ["social_security_type", "housing_fund_base_type", "housing_fund_employee_rate"]
    .some((key) => offer.input_values?.[key] == null);
  const months = offer.salary?.monthly_rows ?? [];
  const items = offer.insurance?.items ?? [];

  return <>
    <button type="button" className="no-print inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50" onClick={() => dialog.current?.showModal()}>税后与五险一金 <span aria-hidden className="ml-1">↗</span></button>
    <dialog ref={dialog} aria-modal="true" aria-label="税后与五险一金明细" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }} className="m-auto max-h-[88vh] w-[min(92vw,760px)] max-w-none overflow-y-auto rounded-2xl border border-slate-200 bg-surface p-0 text-ink shadow-float backdrop:bg-slate-950/50 max-sm:mb-0 max-sm:max-h-[92vh] max-sm:w-full max-sm:rounded-b-none">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-hairline bg-surface/95 px-5 py-4 backdrop-blur sm:px-7">
        <h2 className="text-xl font-semibold">税后与五险一金</h2>
        <button type="button" onClick={() => dialog.current?.close()} aria-label="关闭明细" className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm text-slate-700 hover:bg-slate-50">关闭</button>
      </div>
      <div className="flex gap-2 border-b border-hairline px-5 py-3 sm:px-7" aria-label="选择 Offer">{offers.map((item) => <button key={item.offer_id} type="button" aria-pressed={item.offer_id === offer.offer_id} onClick={() => setSelectedOfferId(item.offer_id)} className={`min-h-11 rounded-lg px-4 text-sm font-medium transition-colors ${item.offer_id === offer.offer_id ? "bg-ink text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>{item.company}</button>)}</div>
      <div className="space-y-8 px-5 py-6 sm:px-7">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">{[
          ["固定年税后", money(offer.key_numbers?.annual_net)],
          ["月均税后", money(offer.salary?.monthly_after_tax_avg)],
          ["年个税", money(offer.salary?.annual_tax)],
          ["单位公积金 / 年", money(offer.salary?.income?.hf_employer)],
        ].map(([label, value]) => <div key={label} className="border-t border-hairline pt-3"><dt className="text-xs text-slate-500">{label}</dt><dd className="metric mt-1 text-lg text-ink">{value}</dd></div>)}</dl>
        <p className="text-sm leading-6 text-slate-600">固定薪数按 12 个月分摊为表中的月均计税额。{estimated ? "未填写的缴费细节采用当地缴费参考参数，税后金额为估算。" : "税后金额按已填写的缴费信息估算。"}个人缴纳已从到手现金中扣除。</p>
        <section><h3 className="text-base font-semibold">月度税后计算</h3>
          {months.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[440px] border-collapse text-right text-sm tabular-nums"><thead className="border-b border-ink text-xs text-slate-500"><tr><th className="py-2 pr-4 text-left font-medium">月份</th><th className="px-4 py-2 font-medium">税前</th><th className="px-4 py-2 font-medium">个税</th><th className="py-2 pl-4 font-medium">到手</th></tr></thead><tbody>{months.map((row) => <tr key={row.month} className="border-b border-hairline"><th scope="row" className="py-2.5 pr-4 text-left font-medium">{row.month} 月</th><td className="px-4 py-2.5">{money(row.tax_pre)}</td><td className="px-4 py-2.5">{money(row.tax)}</td><td className="py-2.5 pl-4 font-semibold">{money(row.after_tax)}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-slate-500">月薪信息不足，暂无法计算。</p>}
        </section>
        <section><h3 className="text-base font-semibold">五险一金 · 每月缴纳</h3>
          {items.length ? <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[380px] border-collapse text-right text-sm tabular-nums"><thead className="border-b border-ink text-xs text-slate-500"><tr><th className="py-2 pr-4 text-left font-medium">项目</th><th className="px-4 py-2 font-medium">个人</th><th className="py-2 pl-4 font-medium">单位</th></tr></thead><tbody>{items.map((row) => <tr key={row.item} className="border-b border-hairline"><th scope="row" className="py-2.5 pr-4 text-left font-medium">{row.item}</th><td className="px-4 py-2.5">{money(row.personal)}</td><td className="py-2.5 pl-4">{money(row.employer)}</td></tr>)}</tbody><tfoot><tr className="font-semibold"><th scope="row" className="py-3 pr-4 text-left">每月合计</th><td className="px-4 py-3">{money(offer.insurance?.personal_monthly)}</td><td className="py-3 pl-4">{money(offer.insurance?.employer_monthly)}</td></tr></tfoot></table></div> : <p className="mt-3 text-sm text-slate-500">缴费信息不足，暂无法列出明细。</p>}
        </section>
      </div>
    </dialog>
  </>;
}

type Metric = { key: string; label: string; format?: "money" | "years" | "hours" | "percent" | "days" };
type Category = { key: string; label: string; metrics: Metric[] };
const reportSections: { key: "economic" | "growth" | "experience"; label: string; categories: Category[] }[] = [
  { key: "economic", label: "经济回报", categories: [
    { key: "cash", label: "常规年度收入", metrics: [
      { key: "fixed_net", label: "固定年度税后", format: "money" },
      { key: "bonus_net", label: "年终奖税后", format: "money" },
      { key: "recurring_net", label: "常规年度税后现金", format: "money" },
      { key: "raise_rate", label: "约定年度调薪", format: "percent" },
      { key: "scored_recurring_net", label: "评分参考税后现金", format: "money" },
    ] },
    { key: "entry", label: "入职阶段收入", metrics: [
      { key: "signing_bonus", label: "签字及安家费", format: "money" },
      { key: "relocation_grant", label: "搬迁安置补助", format: "money" },
      { key: "government_talent_subsidy", label: "政府人才补贴", format: "money" },
      { key: "entry_income", label: "入职阶段收入合计", format: "money" },
    ] },
    { key: "probation", label: "试用期", metrics: [{ key: "probation_loss", label: "试用期少拿金额", format: "money" }] },
    { key: "purchasing", label: "购买力", metrics: [
      { key: "purchasing_monthly", label: "城市调整后月购买力", format: "money" },
      { key: "scored_purchasing_monthly", label: "评分参考月购买力", format: "money" },
    ] },
    { key: "benefits", label: "福利", metrics: [{ key: "benefits_annual", label: "年度福利价值", format: "money" }] },
    { key: "housing", label: "买房压力", metrics: [
      { key: "down_payment", label: "参考首付", format: "money" },
      { key: "down_payment_years", label: "攒首付年限", format: "years" },
      { key: "monthly_payment", label: "参考月供", format: "money" },
      { key: "payment_income_ratio", label: "月供收入比", format: "percent" },
    ] },
  ] },
  { key: "growth", label: "职业成长", categories: [
    { key: "opportunity", label: "业务机会", metrics: [] },
    { key: "responsibility", label: "承担与自主", metrics: [] },
    { key: "skills", label: "技能积累", metrics: [] },
    { key: "cultivation", label: "培养支持", metrics: [] },
    { key: "options", label: "后续选择空间", metrics: [] },
  ] },
  { key: "experience", label: "工作体验", categories: [
    { key: "time", label: "时间占用", metrics: [
      { key: "occupied_weekly", label: "每周占用时间", format: "hours" },
      { key: "peak_extra_weekly", label: "旺季折算增加", format: "hours" },
      { key: "commute_weekly", label: "每周往返通勤", format: "hours" },
    ] },
    { key: "rest", label: "休息安排", metrics: [
      { key: "rest_days_weekly", label: "每周休息天数", format: "days" },
      { key: "extra_leave_days", label: "额外带薪假期", format: "days" },
    ] },
    { key: "boundary", label: "工作边界", metrics: [
      { key: "travel_days_annual", label: "折算年度出差天数", format: "days" },
      { key: "weekend_overtime_days_annual", label: "折算年度周末加班天数", format: "days" },
    ] },
    { key: "daily", label: "日常环境", metrics: [] },
  ] },
];

/** 一句话人话概括：显示在说明弹层最上方，完整口径紧随其后。 */
const fieldSummaries: Record<string, string> = {
  "economic.cash": "每年实际能拿到手的现金（税后），含年终奖。",
  "economic.entry": "入职时一次性拿到的钱，比如签字费、安家费。",
  "economic.probation": "试用期工资打了折，一共少拿多少。",
  "economic.purchasing": "到手的钱放在这座城市，能买到多少东西。",
  "economic.benefits": "公司替你出的钱：公积金、餐补、住宿、补充医疗。",
  "economic.housing": "按当地房价估算，买房的压力有多大。",
  "growth.opportunity": "接触的业务重不重要，能不能看到用户和结果。",
  "growth.responsibility": "新人能担多大的事，有多大的自主权。",
  "growth.skills": "做的事能不能练出换公司也带得走的本事。",
  "growth.cultivation": "有没有人带、有没有及时反馈和培训。",
  "growth.options": "以后转岗、展示成果、用 AI 工具的空间。",
  "experience.time": "工作加通勤，每周总共占掉多少时间。",
  "experience.rest": "每周休息几天，有没有额外带薪假。",
  "experience.boundary": "出差、值班、周末加班打扰生活的程度。",
  "experience.daily": "弹性安排、会议、上级与团队氛围、办公环境。",
};

const fieldExplanations: Record<string, string> = {
  "economic.cash": "这是常规年度现金收入的子分。固定薪资、年终奖及加班补偿按税后口径计算；约定调薪只影响这个子分，不加入下方展示的常规年度金额。不缴或按最低基数缴费时，评分改用按工资缴费的参考金额，实际到手仍如实展示。",
  "economic.fixed_net": "税前月薪乘以固定薪数，并计入固定现金补贴；按个税和五险一金规则估算全年到手现金。缴费细节未填写时使用城市参考参数。",
  "economic.bonus_net": "按填写的年终奖方式及金额，使用个税规则估算到手年终奖；未填写则按 0 处理。",
  "economic.recurring_net": "固定年度税后现金、年终奖税后和加班补偿税后估值之和；不包含入职阶段的一次性收入。",
  "economic.raise_rate": "仅在有 Offer 填写正数调薪率时显示，未填写按 0。现金子分按当前及随后两年的固定薪资估值计算，后两年按此比例逐年调增；上方常规年度现金仍表示当前年度。",
  "economic.scored_recurring_net": "仅当填写了不缴或最低基数缴费、且评分参考金额与实际到手不同才显示。为避免少缴费抬高现金分，评分改按工资基数估算五险一金；实际到手仍见上一行。",
  "economic.entry": "这是入职阶段一次性收入的子分。三项金额直接相加，按金额档位换算成 0–100 分；这里不估算税后，也不并入常规年度收入。",
  "economic.signing_bonus": "填写的签字费及安家费名义金额；未填写按 0 计入本项。",
  "economic.relocation_grant": "填写的搬迁或安置补助名义金额；未填写按 0 计入本项。",
  "economic.government_talent_subsidy": "填写的政府人才补贴名义金额；未填写按 0 计入本项。",
  "economic.entry_income": "签字及安家费、搬迁安置补助、政府人才补贴之和，使用同一名义金额口径。",
  "economic.probation": "这是试用期收入损失的子分。试用期少拿金额相对月薪越少，分数越高；没有填试用期折薪时按没有损失计算。",
  "economic.probation_loss": "税前月薪 × 试用期月数 ×（1－试用期工资比例）。这是试用期相对正常月薪少拿的税前金额。",
  "economic.purchasing": "展示经城市生活成本调整后的月购买力；子分以 50 分为中性值，只计入城市调整前后购买力档位的分差。现金收入已在常规年度收入中评分，不在这里重复记分。",
  "economic.purchasing_monthly": "实际常规年度税后现金 ÷ 12 × 全国参考月生活成本 ÷ 工作城市参考月生活成本。若缴费安排触发评分参考口径，评分使用下方另列的参考月购买力。",
  "economic.scored_purchasing_monthly": "仅当实际缴费与评分参考口径不同时显示。按工资基数缴费的税后现金，再经城市生活成本调整；用于购买力子分的计算。",
  "economic.benefits": "这是福利的子分。用单位公积金、餐宿及补充医疗的年度价值相对评分参考年度税后现金的比例评分；个人公积金不重复计入。",
  "economic.benefits_annual": "单位公积金年度缴纳额，加上明确提供的餐宿福利和补充医疗年度价值；不包含个人缴纳部分。",
  "economic.housing": "这是买房压力的子分，仅在选择考虑买房时出现。参考月供占固定税后月收入的比例越低、攒首付时间越短，得分越高。",
  "economic.down_payment": "按工作城市参考房价、参考住房面积和首付比例估算的首付金额。",
  "economic.down_payment_years": "参考首付除以固定年度税后现金的预计可储蓄部分，得到攒首付的参考年限。",
  "economic.monthly_payment": "按参考房价、首付比例及贷款参数估算的每月房贷还款额。",
  "economic.payment_income_ratio": "参考月供 ÷ 固定年度税后现金的月均值。比例越低，月供压力越小。",
  "growth.opportunity": "业务范围的分值为基础；若有 Offer 能接触用户或业务结果，该项也进入本轮评分，未填写按无接触处理。",
  "growth.responsibility": "新人承担层级为基础；所有 Offer 都填写自主程度后，一起换算为承担与自主分。",
  "growth.skills": "所有 Offer 均填写的岗位匹配、问题复杂度、技能通用性及目标技能契合度分别换算后取平均；未形成共同对比的项目不加入。",
  "growth.cultivation": "带教和反馈按选项换算；明确提供的培训天数、预算也换算纳入。带教或反馈有高于最低档的安排时，未填写方按最低档处理。",
  "growth.options": "内部流动、成果展示许可、AI 工具条件分别按选项换算。单方明确具有的机会也能得分，其他未填写方按没有处理。",
  "experience.time": "每周工时加上共同可比的旺季增量和往返通勤，按工时档位评分；占用越少越好。",
  "experience.occupied_weekly": "普通周工时＋旺季额外工时的每周平均值＋每周往返通勤；额外假期归入休息安排，不从普通周扣除。",
  "experience.peak_extra_weekly": "（旺季周工时－普通周工时）的正数部分 × 旺季周数 ÷ 52；所有 Offer 都填两项时才参与。",
  "experience.commute_weekly": "单程分钟 × 2 ×（每周工作天数－每周远程天数）÷ 60；所有 Offer 都填通勤时间时才参与。",
  "experience.rest": "每周工作天数决定基础休息分；明确提供的额外带薪假增加子分，不重复改变普通周占用时间。",
  "experience.rest_days_weekly": "7－每周工作天数；这是普通一周可以休息的天数。",
  "experience.extra_leave_days": "明确提供的额外带薪假期天数；有一份 Offer 填写时，其他未填写按 0 天参与休息评分。",
  "experience.boundary": "本轮可比的值班、下班后响应、周末加班和出差分别评分后取平均；后两项须所有 Offer 都填写才加入。",
  "experience.travel_days_annual": "每月出差天数 × 12；只用于比较安排频率，不代表一年实际出差日期的预测。",
  "experience.weekend_overtime_days_annual": "每月周末加班天数 × 12；只用于比较安排频率，不代表一年实际加班日期的预测。",
  "experience.daily": "本轮可比的弹性安排、会议、主管与团队支持、工作意义、办公环境和绩效压力等选项分别换算后取平均。通勤尚不可比时，明确提供的远程安排也计入本项。",
};

function FieldInfo({ label, summary, description }: { label: string; summary?: string; description: string }) {
  const id = useId();
  return <span className="no-print group inline-flex align-middle">
    <button type="button" aria-label={`${label}说明`} aria-describedby={id} className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:bg-slate-100 focus-visible:text-slate-700">ⓘ</button>
    <span id={id} role="tooltip" className="pointer-events-none invisible absolute left-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-3rem)] rounded-xl border border-slate-200 bg-surface px-4 py-3 text-left text-xs font-normal leading-5 text-slate-700 opacity-0 shadow-float transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
      {summary && <span className="mb-1.5 block text-sm font-semibold leading-5 text-ink">{summary}</span>}
      {summary && <span className="mb-1 block text-[11px] font-medium text-slate-500">计算口径</span>}
      {description}
    </span>
  </span>;
}

/** 至少有一个维度能在所有 Offer 上对比时，详细依据才有内容。 */
function hasDetail(offers: OfferReportView[]) {
  return reportSections.some((section) => section.categories.some((category) =>
    offers.every((offer) => offer.sub_scores?.[`${section.key}.${category.key}`] != null)));
}

function ReportAnalysis({ offers }: { offers: OfferReportView[] }) {
  const columns = offers.length === 2 ? "grid-cols-2 md:grid-cols-[minmax(10rem,1fr)_repeat(2,minmax(0,1fr))]" : "grid-cols-3 md:grid-cols-[minmax(10rem,1fr)_repeat(3,minmax(0,1fr))]";
  const labelSpan = offers.length === 2 ? "col-span-2 md:col-span-1" : "col-span-3 md:col-span-1";
  const metricValue = (offer: OfferReportView, key: string, format?: Metric["format"]) => {
    const value = offer.sub_metrics?.[key];
    if (value == null) return "—";
    if (format === "money") return money(value);
    if (format === "years") return `${value.toFixed(1)} 年`;
    if (format === "percent") return `${(value * 100).toFixed(1)}%`;
    if (format === "hours") return `${value.toFixed(key.endsWith("annual") ? 0 : 1)} 小时`;
    if (format === "days") return `${value.toFixed(Number.isInteger(value) ? 0 : 1)} 天`;
    return value.toFixed(1);
  };
  return <div className="space-y-12" role="region" aria-label="三维结果分析">{reportSections.map((section, sectionIndex) => {
    const categories = section.categories.filter((category) => offers.every((offer) => offer.sub_scores?.[`${section.key}.${category.key}`] != null));
    if (!categories.length) return null;
    return <section key={section.key} className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink pb-3"><div><p className="eyebrow">维度 0{sectionIndex + 1}</p><h2 className="section-title mt-1">{section.label}</h2></div>{section.key === "economic" && <TaxInsuranceDialog offers={offers} />}</div>
      <div>
        <div className={`grid ${columns} items-center gap-3 border-b border-hairline py-3 text-xs font-semibold text-slate-500`}><span className={`${labelSpan} hidden md:block`}>对比结果</span>{offers.map((offer) => <span key={offer.offer_id} className="truncate text-right">{offer.company}</span>)}</div>
        <div className={`grid ${columns} items-center gap-x-3 gap-y-1 border-b border-hairline bg-slate-100/70 px-3 py-3`} aria-label={`${section.label}维度总分`}>
          <span className={`${labelSpan} text-sm font-semibold text-ink`}>维度总分</span>
          {offers.map((offer) => <strong key={offer.offer_id} className="metric text-right text-xl text-ink">{score(offer.dimension_scores?.[section.key])}<span className="ml-1 text-xs font-normal text-slate-500">分</span></strong>)}
        </div>
        {categories.map((category) => {
          const fullKey = `${section.key}.${category.key}`;
          const metrics = category.metrics.filter((metric) => offers.some((offer) => {
            const value = offer.sub_metrics?.[`${section.key}.${metric.key}`];
            return value != null && (section.key === "experience" || metric.key === "entry_income" || metric.key === "recurring_net" || metric.key === "fixed_net" || metric.key === "purchasing_monthly" || metric.key === "benefits_annual" || value !== 0);
          }));
          return <div key={fullKey} className="border-b border-hairline py-4 last:border-0">
            <div className={`grid ${columns} items-baseline gap-x-3 gap-y-1`}><h3 className={`${labelSpan} relative font-semibold text-ink`}>{category.label}<FieldInfo label={category.label} summary={fieldSummaries[fullKey]} description={fieldExplanations[fullKey]} /></h3>{offers.map((offer) => <div key={offer.offer_id} className="metric text-right font-semibold text-ink">{score(offer.sub_scores?.[fullKey])}<span className="ml-1 text-xs font-normal text-slate-500">分</span></div>)}</div>
            {metrics.map((metric) => <div key={metric.key} className={`mt-2 grid ${columns} gap-x-3 gap-y-1 text-sm`}><span className={`${labelSpan} relative text-slate-500`}>{metric.label}<FieldInfo label={metric.label} description={fieldExplanations[`${section.key}.${metric.key}`]} /></span>{offers.map((offer) => <span key={offer.offer_id} className="num min-w-0 text-right text-slate-700">{metricValue(offer, `${section.key}.${metric.key}`, metric.format)}</span>)}</div>)}
            {fullKey === "economic.cash" && offers.some((offer) => offer.compliance_alert) && <p className="mt-2 text-xs leading-5 text-amber-800">{offers.filter((offer) => offer.compliance_alert).map((offer) => offer.company).join("、")} 的缴费安排需核实；现金与购买力评分已排除未缴或最低基数缴费带来的到手增量。</p>}
          </div>;
        })}
      </div>
      <AiReportSection part={section.key} />
    </section>;
  })}</div>;
}

function ResultPageInner() {
  const sessionId = useFlowStore((state) => state.sessionId);
  useHydrateSession();
  const { data: view, isLoading, error } = useResult(sessionId);
  useEffect(() => { document.title = "三维对比报告 · MyOffer"; }, []);


  if (!sessionId) return <NeedSession />;
  if (isLoading) return <Spinner label="正在生成对比…" />;
  if (!view) return <main className="mx-auto max-w-6xl px-5 py-14"><h1 className="text-2xl font-semibold">对比报告</h1><p className="mt-4 text-sm text-slate-600">{readApiError(error, "请先填写 Offer 信息")}</p><Link href="/complete" className="mt-5 inline-flex min-h-11 items-center text-sm underline">返回填写</Link></main>;

  const offers = [...(view.offers ?? [])].sort((a, b) => a.display_order - b.display_order);
  const verdict = buildVerdict(offers);
  const ranked = verdict.kind === "ranked";
  const weightSummary = preferenceWeightSummary(offers[0]?.effective_weights);

  return <AiReportAnalysisProvider sessionId={sessionId} snapshotSeq={view.snapshot_seq} complete={ranked}><main className="report-document mx-auto max-w-5xl text-ink">
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 pb-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink">三维对比报告</h1>
        <p className="text-sm text-slate-500">{offers.length} 份 Offer · 经济回报、职业成长、工作体验</p>
      </div>
      <div className="no-print -mx-3 flex items-center gap-1 text-sm">
        <Link href="/complete" className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-slate-700 hover:bg-slate-100">继续填写</Link>
        <ReportPrint />
      </div>
    </header>

    <section aria-labelledby="scores-title" className="border-t border-hairline py-10">
      <h2 id="scores-title" className="section-title">三个维度的得分</h2>
      <div className="mt-6">
        <Scoreboard offers={offers} />
      </div>
      <div className="mt-4 text-sm leading-6 text-slate-500" aria-label="偏好权重声明">
        <p>综合分采用当前偏好权重：{weightSummary}。</p>
        {!ranked && <p className="text-amber-800">每份 Offer 的七项基本信息齐全后显示综合分与排名。</p>}
      </div>
    </section>

    <VerdictHero verdict={verdict} />
    <Reasons verdict={verdict} attribution={view.attribution} />
    <KeyNumbers offers={offers} />
    <Stability offers={offers} sensitivity={view.sensitivity} />
    <Reliability offers={offers} verdict={verdict} />
    <NextSteps offers={offers} />

    <section aria-label="总体结果分析"><AiReportSection part="overall" /></section>

    {hasDetail(offers) && <div id="details" className="mt-4 border-t-2 border-ink pt-10">
      <p className="eyebrow">详细依据</p>
      <h2 className="section-title mt-2">每一分是怎么来的</h2>
      <p className="section-lede mb-10 mt-2">需要核对细节时再看这里：各维度的分项、具体数字，以及税后和五险一金的逐月计算。</p>
      <ReportAnalysis offers={offers} />
    </div>}
  </main></AiReportAnalysisProvider>;
}

export default function ResultsPage() { return <ResultPageInner />; }
