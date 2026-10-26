"use client";

/**
 * 信息补全页的共享答题组件（v0.6 从原 questions 页抽出）。
 *
 * 包含：字段依赖联动、草稿/服务端状态合并、Offer 三列并排输入（OfferColumn）。
 * 页面级编排在 app/complete/page.tsx。
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Heart } from "lucide-react";
import {
  type FieldDraft,
  type OfferResource,
  type RenderField,
  type RenderedQuestion,
} from "@/lib/api/types";
import { useCityTiers } from "@/lib/api/hooks";
import { fieldLabel } from "@/lib/constants";

/** 从服务端问题状态还原某字段的已答状态；后端的 unknown / need_confirmation 在 UI 上都映射为 pending。 */
export function serverFieldDraft(
  q: RenderedQuestion, oid: string, fk: string,
): FieldDraft | undefined {
  const st = q.offers?.[oid];
  if (!st) return undefined;
  const status = st.statuses?.[fk] ?? (st.values && fk in st.values ? "known" : undefined);
  if (status !== "known" && status !== "unknown" && status !== "need_confirmation" && status !== "not_applicable") {
    return undefined;
  }
  const localStatus: FieldDraft["status"] =
    status === "unknown" || status === "need_confirmation"
      ? "pending"
      : (status as "known" | "not_applicable");
  if (localStatus === "pending" || localStatus === "not_applicable") {
    return { status: localStatus };
  }
  return { status: localStatus, value: st.values?.[fk] };
}

export type CellState = "unanswered" | "known" | "pending" | "not_applicable";

/** 字段依赖：当依赖字段的值等于 trigger 值时，本字段自动标记为「不适用」（随作答提交） */
export const FIELD_DEPENDENCY: Record<string, { on: string; equals: unknown[] }> = {
};

/** 这些字段仅作为旧版决策指标的兼容值，由可见输入推导，不直接展示。 */
export const HIDDEN_DERIVED_FIELDS = new Set([
  "annual_bonus_months",
  "housing_fund_employer_rate",
  "travel_frequency",
  "weekend_pattern",
  "strategic_position",
  "business_trend_status",
]);

/** 只有用户选中相应方式后，才显示需要额外输入的字段。 */
export const FIELD_VISIBILITY: Record<string, { on: string; oneOf: unknown[] }> = {
  annual_bonus_value: { on: "annual_bonus_method", oneOf: ["amount", "multiple"] },
  social_security_base: { on: "social_security_type", oneOf: ["custom"] },
  housing_fund_employee_rate: { on: "housing_fund_base_type", oneOf: ["salary", "minimum", "custom"] },
  housing_fund_base: { on: "housing_fund_base_type", oneOf: ["custom"] },
};

function visibleFields(fields: RenderField[], draft: Record<string, FieldDraft>): RenderField[] {
  return fields.filter((field) => {
    if (HIDDEN_DERIVED_FIELDS.has(field.field_key)) return false;
    const visibility = FIELD_VISIBILITY[field.field_key];
    if (!visibility) return true;
    const parent = draft[visibility.on];
    return parent?.status === "known" && visibility.oneOf.includes(parent.value);
  });
}

export function dependencyTriggered(
  draft: FieldDraft | undefined,
  dependency: { on: string; equals: unknown[] },
): boolean {
  return Boolean(
    draft?.status === "known" && dependency.equals.includes(draft.value),
  );
}

export function questionStatus(
  q: RenderedQuestion, drafts: NodeDraft, offerList: OfferResource[],
) {
  const fields = q.fields ?? [];
  let total = 0;
  let answered = 0;
  for (const o of offerList) {
    const row = drafts[q.question_key]?.[o.offer_id] ?? {};
    const merged: Record<string, FieldDraft> = { ...row };
    for (const field of fields) {
      const server = serverFieldDraft(q, o.offer_id, field.field_key);
      if (!merged[field.field_key] && server) merged[field.field_key] = server;
    }
    const activeFields = visibleFields(fields, merged);
    total += activeFields.length;
    for (const f of activeFields) {
      const d = merged[f.field_key];
      // 依赖字段取触发值时，子字段按「不适用」计入已答（与提交时的自动标记一致）
      const dep = FIELD_DEPENDENCY[f.field_key];
      let naByParent = false;
      if (dep) {
        const pd = drafts[q.question_key]?.[o.offer_id]?.[dep.on]
          ?? serverFieldDraft(q, o.offer_id, dep.on);
        naByParent = dependencyTriggered(pd, dep);
      }
      // A dependency is authoritative: an old child value must not keep an
      // equity-only field answered after the parent changes to "none".
      const staleNotApplicable = Boolean(
        dep && d?.status === "not_applicable" && !naByParent,
      );
      const st: CellState = naByParent
        ? "not_applicable"
        : staleNotApplicable ? "unanswered" : d ? d.status : "unanswered";
      if (st !== "unanswered") answered += 1;
    }
  }
  const label: "未填写" | "部分完成" | "已完成" =
    total === 0 ? "已完成"
      : answered === 0 ? "未填写"
        : answered < total ? "部分完成" : "已完成";
  return { total, answered, label };
}

export const STATUS_TONE: Record<string, "neutral" | "amber" | "green"> = {
  未填写: "neutral", 部分完成: "amber", 已完成: "green",
};

/** 单 Offer 视角的本题作答数（Offer 卡片分节折叠布局用）。
 *  与 questionStatus 同口径，只是把「全部 Offer」收窄到单个 Offer。 */
export function questionStatusForOffer(
  q: RenderedQuestion, oid: string, drafts: NodeDraft,
): { total: number; answered: number } {
  const fields = q.fields ?? [];
  const merged: Record<string, FieldDraft> = { ...(drafts[q.question_key]?.[oid] ?? {}) };
  for (const field of fields) {
    const server = serverFieldDraft(q, oid, field.field_key);
    if (!merged[field.field_key] && server) merged[field.field_key] = server;
  }
  const activeFields = visibleFields(fields, merged);
  let answered = 0;
  for (const f of activeFields) {
    const d = merged[f.field_key];
    const dep = FIELD_DEPENDENCY[f.field_key];
    let naByParent = false;
    if (dep) {
      const pd = drafts[q.question_key]?.[oid]?.[dep.on]
        ?? serverFieldDraft(q, oid, dep.on);
      naByParent = dependencyTriggered(pd, dep);
    }
    const staleNotApplicable = Boolean(
      dep && d?.status === "not_applicable" && !naByParent,
    );
    const st: CellState = naByParent
      ? "not_applicable"
      : staleNotApplicable ? "unanswered" : d ? d.status : "unanswered";
    if (st !== "unanswered") answered += 1;
  }
  return { total: activeFields.length, answered };
}

/** 每题每 Offer 每字段的本地草稿（仅用户编辑；展示层与"服务端已答状态"合并） */
export type NodeDraft = Record<string, Record<string, Record<string, FieldDraft>>>;

/** 后端字段目录附带的收集页显示元数据。旧 OpenAPI 类型没有这些可选键时，
 * 仍允许前端兼容旧目录；新目录会返回默认值和双值行分组信息。 */
type UiRenderField = RenderField & {
  default_value?: unknown;
  ui_group?: string | null;
  ui_role?: string | null;
};

function asUiField(field: RenderField): UiRenderField {
  return field as UiRenderField;
}

/** 生成报告前的 UI 引导必填集（滚动定位与「选填」占位符）。
 *  ⚠️ 与 /meta field_rules.required_core_fields（后端决策必需度口径）是
 *  两个不同的概念——fields.yaml 注释明确 core 不再代表表单必填；本集合
 *  是产品定义的「报告可对比的最低信息要求」，改动需同时过产品语义。 */
export const REQUIRED_FIELDS = new Set(["city", "monthly_base", "guaranteed_salary_months", "business_level", "entry_scope", "weekly_work_hours", "work_days_per_week"]);

const FIELD_UNIT: Record<string, string> = {
  monthly_base: "元/月",
  guaranteed_salary_months: "月/年",
  annual_bonus_value: "元",
  social_security_base: "元/月",
  housing_fund_employee_rate: "%",
  housing_fund_base: "元/月",
  signing_bonus: "元",
  monthly_subsidies: "元/月",
  daily_idle_hours: "时/天",
  commute_hours: "时",
  commute_minutes: "分钟",
  weekly_work_hours: "小时/周",
  work_days_per_week: "天",
  travel_days_per_month: "天/月",
  probation_months: "月",
  probation_pay_percent: "%",
  annual_raise_percent: "%/年",
  relocation_grant: "元",
  supplementary_medical_value: "元/年",
  overtime_comp_annual: "元/年",
  training_days_year: "天/年",
  training_budget_year: "元/年",
  peak_week_hours: "小时/周",
  peak_weeks_year: "周/年",
  remote_days_week: "天/周",
  extra_paid_leave: "天/年",
  weekend_overtime_days_month: "天/月",
};

const FIELD_STEP: Record<string, string> = {
  city_affinity: "1",
  business_affinity: "1",
  housing_fund_employee_rate: "0.5",
  signing_bonus: "0.1",
  monthly_subsidies: "0.1",
  daily_idle_hours: "0.5",
  commute_hours: "0.1",
  work_days_per_week: "0.5",
  travel_days_per_month: "1",
};

/** 数值输入上限：与 backend rules/fields.yaml 各字段声明的 max 对齐；
 *  未列出的字段后端同样无上限。超限提交会被后端 422（out_of_range）。
 *
 *  ⚠️ 本表只是 /meta field_rules.bounds 未返回时的兜底（两者当前一致），
 *  权威值由 useFieldRules 下发并经 syncFieldBounds 注入——手抄两份曾因
 *  规则调整漂移（审查 F8），不要在这里新增字段上限，去 fields.yaml 改。 */
const FIELD_MAX: Record<string, number> = {
  monthly_base: 1_000_000,
  guaranteed_salary_months: 16,
  annual_bonus_months: 12,
  housing_fund_employee_rate: 12,
  housing_fund_employer_rate: 12,
  weekly_work_hours: 168,
  commute_hours: 24,
  commute_minutes: 240,
  daily_idle_hours: 24,
  work_days_per_week: 7,
  travel_days_per_month: 31,
  business_affinity: 5,
  city_affinity: 5,
};

const FIELD_STORAGE_UNITS_PER_DISPLAY_UNIT: Record<string, number> = {};

export type FieldBounds = Record<string, { min?: number | null; max?: number | null }>;

let liveFieldBounds: FieldBounds = {};

/** 注入 /meta field_rules.bounds（complete 页 useFieldRules 返回后调用）。
 *  模块级注入而非 prop 下传：字段值当前与 FIELD_MAX 兜底一致，memo 列
 *  不重渲染也无输出差异；若未来后端调整上限，重载页面后即生效。 */
export function syncFieldBounds(bounds: FieldBounds | undefined): void {
  liveFieldBounds = bounds ?? {};
}

function fieldMax(fieldKey: string): number | undefined {
  const declared = liveFieldBounds[fieldKey];
  return (typeof declared?.max === "number" ? declared.max : undefined) ?? FIELD_MAX[fieldKey];
}

/** 派生值按目标字段的声明边界钳制。源字段与派生目标的合法区间可能不一致
 *  （通勤小时 ≤24 ×60 → 分钟 ≤240；年终奖倍数无上限 → 月数 ≤12），
 *  超界派生值会被后端 422 整单拒绝，且派生字段对用户隐藏、无法定位修复。
 *  min 缺省 0，与后端数值字段的默认下限一致。 */
export function clampToFieldBounds(fieldKey: string, value: number): number {
  const declared = liveFieldBounds[fieldKey];
  const lo = typeof declared?.min === "number" ? declared.min : 0;
  const hi = fieldMax(fieldKey);
  return Math.min(Math.max(value, lo), hi ?? Number.POSITIVE_INFINITY);
}

function fieldUnit(fieldKey: string, draft: Record<string, FieldDraft>): string | undefined {
  if (fieldKey === "annual_bonus_value" && draft.annual_bonus_method?.value === "multiple") {
    return "倍";
  }
  return FIELD_UNIT[fieldKey];
}

/** 年终奖方式选「倍数」时，同一输入框承载的是月薪倍数而非金额，标签随之切换。 */
function fieldLabelText(fieldKey: string, draft: Record<string, FieldDraft>): string {
  if (fieldKey === "annual_bonus_value" && draft.annual_bonus_method?.value === "multiple") {
    return "年终奖倍数";
  }
  return fieldLabel(fieldKey);
}

function fieldDisplayValue(fieldKey: string, value: unknown): string {
  if (typeof value !== "number") return value === undefined || value === null ? "" : String(value);
  const scale = FIELD_STORAGE_UNITS_PER_DISPLAY_UNIT[fieldKey] ?? 1;
  return String(value / scale);
}

function fieldStoredValue(fieldKey: string, displayValue: number): number {
  return displayValue * (FIELD_STORAGE_UNITS_PER_DISPLAY_UNIT[fieldKey] ?? 1);
}

const CHIP_BASE = "min-h-11 rounded-lg border px-3 py-2 text-xs transition";
function choiceChip(active: boolean): string {
  return `${CHIP_BASE} ${active
    ? "border-blue-600 bg-blue-50 font-semibold text-blue-800"
    : "border-slate-300 bg-surface text-slate-600 hover:border-slate-400 hover:bg-slate-50"}`;
}

const GROUP_JOINER: Record<string, string> = {
  signing_bonus_bundle: "，第",
  subsidy_bundle: "，补",
};

function groupFieldRows(fields: RenderField[]): UiRenderField[][] {
  const rows: UiRenderField[][] = [];
  const groups = new Map<string, UiRenderField[]>();
  for (const rawField of fields) {
    const field = asUiField(rawField);
    if (!field.ui_group) {
      rows.push([field]);
      continue;
    }
    const existing = groups.get(field.ui_group);
    if (existing) existing.push(field);
    else {
      const row = [field];
      groups.set(field.ui_group, row);
      rows.push(row);
    }
  }
  return rows;
}

/** 线级分组展示顺序（city_index tier 标签口径；四线/五线合并为"省会兜底"档，
 *  tier 缺失（/meta 未就绪或键异常）的城市归入"其他"，绝不下拉里丢城市）。 */
const CITY_GROUP_ORDER = ["一线", "新一线", "二线", "三线", "省会兜底", "其他"] as const;

function cityGroupOf(tier: string | undefined): string {
  if (tier === "四线" || tier === "五线") return "省会兜底";
  if (tier && (CITY_GROUP_ORDER as readonly string[]).includes(tier)) return tier;
  return "其他";
}

/** 自定义城市下拉：原生 select 的弹层样式不可控（文字无法居中、直角、系统配色），
 *  改用 listbox 模式实现——框内与弹层文字均居中，圆角与整站卡片风格一致。
 *  文字用 flex-1 独立居中、箭头固定在右侧 padding 处（不能用 justify-center 整组居中，
 *  否则箭头会随城市名变短向中间漂移）；键盘：↑/↓ 移动高亮、Enter 选中、Esc 关闭；
 *  点击弹层外部自动收起。
 *  v0.7：universe 扩到 121 城 → 弹层顶部加名称过滤框，选项按线级分组展示
 *  （/meta city_tiers）。线级仅用于分组展示，选项合法性仍由后端白名单校验。 */
function CityDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const tiers = useCityTiers().data ?? {};

  // 过滤 + 分组；高亮索引基于"占位项 + 过滤后全部选项"的扁平序列（组标题不占位）
  const kw = query.trim();
  const filtered = kw ? options.filter((option) => option.label.includes(kw)) : options;
  const byGroup = new Map<string, { value: string; label: string }[]>();
  for (const option of filtered) {
    const group = cityGroupOf(tiers[option.value]);
    const bucket = byGroup.get(group);
    if (bucket) bucket.push(option);
    else byGroup.set(group, [option]);
  }
  const groups = CITY_GROUP_ORDER.filter((g) => (byGroup.get(g)?.length ?? 0) > 0);
  const flat = [{ value: "", label: "请选择城市" }, ...groups.flatMap((g) => byGroup.get(g) ?? [])];
  const selectedIdx = Math.max(0, flat.findIndex((item) => item.value === value));
  const hl = Math.min(highlight, flat.length - 1);

  // 打开期间：点击外部 / Esc 关闭（监听挂在 document，弹层外的任何点击都能收起）
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery(""); // 关闭即清空过滤词，下次打开恢复完整列表
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  type Row =
    | { kind: "group"; label: string }
    | { kind: "option"; index: number; item: { value: string; label: string } };
  const rows: Row[] = [{ kind: "option", index: 0, item: flat[0] }];
  let optionIdx = 1;
  for (const g of groups) {
    rows.push({ kind: "group", label: g });
    for (const item of byGroup.get(g) ?? []) {
      rows.push({ kind: "option", index: optionIdx, item });
      optionIdx += 1;
    }
  }

  const commit = (index: number) => {
    setOpen(false);
    setQuery("");
    const chosen = flat[index];
    if (chosen) onChange(chosen.value === "" ? undefined : chosen.value);
  };

  const moveHighlight = (delta: number) => {
    setHighlight((prev) => (Math.min(prev, flat.length - 1) + delta + flat.length) % flat.length);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) setHighlight(selectedIdx);
          else setQuery(""); // 触发按钮收起时同样清空过滤词
          setOpen((prev) => !prev);
        }}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            moveHighlight(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            commit(hl);
          }
        }}
        className={`flex h-11 min-w-[10rem] items-center gap-3 rounded-xl border bg-slate-50 px-3 text-sm transition ${
          open
            ? "border-blue-300 ring-2 ring-blue-100"
            : "border-neutral-200 hover:border-neutral-300"
        }`}
      >
        <span className={`flex-1 text-left ${value ? "text-slate-800" : "text-slate-500"}`}>
          {flat[selectedIdx]?.label}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-max min-w-full overflow-hidden rounded-xl border border-hairline bg-white shadow-float">
          <div className="border-b border-hairline p-1.5">
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  commit(hl);
                }
              }}
              placeholder="输入城市名过滤"
              aria-label={`过滤${label}`}
              className="w-full rounded-lg border border-neutral-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-800 outline-none transition placeholder:text-neutral-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <ul
            role="listbox"
            aria-label={label}
            className="max-h-72 list-none overflow-y-auto p-1"
          >
            {kw && groups.length === 0 && (
              <li role="presentation" className="cursor-default px-3 py-2 text-center text-xs text-neutral-400">
                未找到匹配的城市
              </li>
            )}
            {rows.map((row) =>
              row.kind === "group" ? (
                <li
                  key={`__group_${row.label}`}
                  role="presentation"
                  className="px-3 pb-1 pt-2 text-left text-[11px] font-medium text-neutral-400"
                >
                  {row.label}
                </li>
              ) : (
                <li
                  key={row.item.value || "__placeholder__"}
                  role="option"
                  aria-selected={row.index === selectedIdx}
                  ref={(el) => {
                    if (row.index === hl) el?.scrollIntoView({ block: "nearest" });
                  }}
                  onMouseEnter={() => setHighlight(row.index)}
                  onClick={() => commit(row.index)}
                  className={`cursor-pointer rounded-lg px-3 py-2 text-center text-xs transition-colors ${
                    row.index === selectedIdx
                      ? "bg-blue-50 font-semibold text-blue-600"
                      : row.index === hl
                        ? "bg-neutral-100"
                        : row.item.value === ""
                          ? "text-neutral-400"
                          : "text-neutral-700"
                  }`}
                >
                  {row.item.label}
                </li>
              ),
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function FieldControl({
  field,
  value,
  draft,
  onChange,
  readOnly,
  showPending,
}: {
  field: UiRenderField;
  value: FieldDraft | undefined;
  draft: Record<string, FieldDraft>;
  onChange: (value: unknown) => void;
  readOnly?: boolean;
  showPending: boolean;
}) {
  const isKnown = value?.status === "known";
  const isNotApplicable = value?.status === "not_applicable";
  const options = field.options ?? [];
  const unit = fieldUnit(field.field_key, draft);
  const label = fieldLabelText(field.field_key, draft);
  // 默认值只作占位符提示（不代填）：用户不填 = 不提交，引擎按缺失口径处理
  const dv = field.default_value;
  const placeholder = REQUIRED_FIELDS.has(field.field_key)
    ? "请填写"
    : dv !== undefined && dv !== null && typeof dv !== "object"
      ? `默认 ${String(dv)}`
      : "选填";
  const chosen = (candidate: unknown) =>
    field.value_type === "multi_enum"
      ? Array.isArray(value?.value) && value.value.includes(candidate)
      : isKnown && String(value?.value) === String(candidate);

  if (readOnly) {
    if (isNotApplicable) return <span className="text-xs text-neutral-400">不适用</span>;
    if (value?.status === "pending" && showPending) return <span className="text-xs text-amber-700">待定</span>;
    if (!isKnown) return <span className="text-xs text-neutral-400">未填写</span>;
    if (field.value_type === "enum" || field.value_type === "multi_enum") {
      const selected = field.value_type === "multi_enum"
        ? (Array.isArray(value.value) ? value.value : [])
        : [value.value];
      return (
        <span className="text-xs text-neutral-700">
          {selected.map((item) => options.find((option) => String(option.value) === String(item))?.label
            ?? String(item)).join("、")}
        </span>
      );
    }
    if (field.value_type === "boolean") {
      return <span className="text-xs text-neutral-700">{value.value ? "是" : "否"}</span>;
    }
    return <span className="text-xs text-neutral-700">{String(value.value ?? "")}{unit ? ` ${unit}` : ""}</span>;
  }

  if (field.field_key === "city") {
    return (
      <CityDropdown
        label={label}
        value={String(value?.value ?? "")}
        options={options.map((option) => ({ value: String(option.value), label: option.label }))}
        onChange={onChange}
      />
    );
  }

  if (field.field_key === "city_affinity" || field.field_key === "business_affinity") {
    const rating = typeof value?.value === "number" ? value.value : 0;
    return (
      <div role="group" aria-label={label} className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((score) => (
          <button
            key={score}
            type="button"
            aria-label={`${score} 分`}
            aria-pressed={rating === score}
            onClick={() => onChange(score)}
            className="flex h-11 w-9 items-center justify-center rounded-lg transition-transform duration-150 hover:bg-rose-50 active:scale-90"
          >
            <Heart
              aria-hidden="true"
              className={`h-5 w-5 ${score <= rating ? "fill-rose-500 text-rose-500" : "text-neutral-300"}`}
            />
          </button>
        ))}
        <span className="ml-1 text-xs font-semibold text-rose-500">{rating || "—"}/5</span>
      </div>
    );
  }

  if (field.value_type === "boolean") {
    const checked = isKnown && value?.value === true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-7 w-12 rounded-full transition ${checked ? "bg-blue-500" : "bg-neutral-200"}`}
      >
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition ${checked ? "left-6" : "left-1"}`} />
      </button>
    );
  }

  if (field.value_type === "enum" || field.value_type === "multi_enum") {
    return (
      <div role="group" aria-label={label} className="flex min-w-0 flex-wrap justify-start gap-2">
        {options.map((option) => {
          const selected = chosen(option.value);
          return (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={selected}
              title={selected && field.value_type !== "multi_enum" ? "再次点击取消选择" : undefined}
              onClick={() => {
                if (field.value_type === "multi_enum") {
                  const current = Array.isArray(value?.value) ? value.value : [];
                  onChange(selected
                    ? current.filter((item) => item !== option.value)
                    : [...current, option.value]);
                } else {
                  // 单选可取消（误触保护）：再点一次 = 清空；
                  // undefined 由 OfferColumn 统一转为「待定」，提交后撤销服务端旧值
                  onChange(selected ? undefined : option.value);
                }
              }}
              className={choiceChip(selected)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    );
  }

  const isTime = field.field_key === "work_start_time" || field.field_key === "work_end_time";
  return (
    <div className="number-control">
      <input
        aria-label={label}
        type={isTime ? "time" : field.value_type === "text" ? "text" : "number"}
        step={isTime ? undefined : FIELD_STEP[field.field_key] ?? "0.1"}
        min={field.value_type === "number" || field.value_type === "money" || field.value_type === "percent" ? 0 : undefined}
        max={fieldMax(field.field_key)}
        placeholder={placeholder}
        value={field.value_type === "text"
          ? String(value?.value ?? "")
          : fieldDisplayValue(field.field_key, value?.value)}
        onChange={(event) => {
          if (field.value_type === "text") onChange(event.target.value || undefined);
          else onChange(event.target.value === ""
            ? undefined
            : fieldStoredValue(field.field_key, Number(event.target.value)));
        }}
        className={`min-w-0 border-0 bg-transparent py-2.5 text-left text-sm tabular-nums text-slate-900 outline-none placeholder:text-slate-400 focus-visible:outline-none ${
          isTime ? "w-32" : field.value_type === "text" ? "w-40" : "w-28"
        }`}
      />
      {unit && <span className="shrink-0 text-xs text-slate-500">{unit}</span>}
    </div>
  );
}

function OfferColumnBase({ qkey, oid, name, fields: fieldsIn, draft, onDraftChange, readOnly, showPending = false, showHeader = true }: {
  qkey: string; oid: string; name: string; fields?: RenderField[];
  draft: Record<string, FieldDraft>;
  onDraftChange: (qkey: string, oid: string, fieldKey: string, draft: FieldDraft | null) => void;
  readOnly?: boolean;
  showPending?: boolean;
  showHeader?: boolean;
}) {
  const onChange = useCallback(
    (fieldKey: string, value: unknown) => {
      // 清空/取消选择（undefined）→ 待定：生成时提交为 unknown，撤销服务端旧值；
      // 曾写成 known+undefined——被进度计成已填、提交时被静默过滤，旧值撤销不掉
      onDraftChange(qkey, oid, fieldKey,
        value === undefined ? { status: "pending" } : { status: "known", value });
    },
    [onDraftChange, qkey, oid],
  );
  // 默认值不再代填进草稿（v0.7.2）：effectiveDraft = 用户编辑 + 服务端已答
  const effectiveDraft = draft;
  const fields = visibleFields(fieldsIn ?? [], effectiveDraft);
  const rows = groupFieldRows(fields);
  return (
    <div>
      {showHeader && <p className="text-xs font-semibold text-neutral-700">{name}</p>}
      <div className="divide-y divide-neutral-100">
        {rows.map((row) => {
          const primary = row[0];
          const group = primary.ui_group;
          return (
            <div
              key={group ?? primary.field_key}
              data-field-anchor={`${oid}:${primary.field_key}`}
              className="form-row rounded-lg"
            >
              <span className="form-label">
                {fieldLabelText(primary.field_key, effectiveDraft)}
                {REQUIRED_FIELDS.has(primary.field_key) && <span className="ml-0.5 text-rose-500">*</span>}
              </span>
              <div className="form-controls">
                {row.map((field, index) => (
                  <div key={field.field_key} className="form-control">
                    {index > 0 && group && (
                      <span className="text-xs text-neutral-500">{GROUP_JOINER[group] ?? "，"}</span>
                    )}
                    <FieldControl
                      field={field}
                      value={effectiveDraft[field.field_key]}
                      draft={effectiveDraft}
                      onChange={(value) => onChange(field.field_key, value)}
                      readOnly={readOnly}
                      showPending={showPending}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
/** draft 的浅比较：未变化的字段条目保持对象引用不变（setField 只替换被编辑的键），
 *  因此一次击键只重渲染受影响的那一列，其余列被 memo 跳过。 */
function draftsShallowEqual(
  a: Record<string, FieldDraft>, b: Record<string, FieldDraft>,
): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export const OfferColumn = memo(OfferColumnBase, (prev, next) =>
  prev.qkey === next.qkey
  && prev.oid === next.oid
  && prev.name === next.name
  && prev.fields === next.fields
  && prev.readOnly === next.readOnly
  && prev.showPending === next.showPending
  && prev.showHeader === next.showHeader
  && prev.onDraftChange === next.onDraftChange
  && draftsShallowEqual(prev.draft, next.draft),
);
