/**
 * 示例数据（体验/演示用）：三份内置城市画像，取值与后端白名单对齐，
 * 覆盖图片中的六个信息分区。
 *
 * 只做草稿预填：buildSampleDrafts 只填充「空字段」（既无本地草稿、也无
 * 服务端已答状态），绝不覆盖用户已填内容；填入后仍走正常提交校验。
 */

import type { FieldDraft, OfferResource, RenderedQuestion } from "@/lib/api/types";
import type { NodeDraft } from "@/components/question-parts";

export const SAMPLE_CITIES = ["北京", "上海", "成都"] as const;

/** qkey → fkey → 预填值（按 Offer 顺序取画像，超出时循环使用）。
 *  取值对标应届本科毕业生的中位offer水平：一线城市 8-10k、新一线 6-7k，
 *  年终奖约 1-2 个月，通勤/工时/补贴取常见区间，供体验时数据不违真。 */
const SAMPLE_PROFILES: Record<string, Record<string, unknown>>[] = [
  {
    q_basic_profile: {
      city: "北京", city_affinity: 5, distance_from_home: "same_province",
      employment_nature: "major_company", is_outsourced: false,
    },
    q_income_base: {
      monthly_base: 9500, guaranteed_salary_months: 12,
      annual_bonus_method: "multiple", annual_bonus_value: 1, annual_bonus_months: 1,
      social_security_type: "salary", housing_fund_base_type: "salary",
      housing_fund_employee_rate: 12, housing_fund_employer_rate: 12,
      special_additional_deductions: ["rent"],
    },
    q_benefits: {
      signing_bonus: 3000, monthly_subsidies: 500,
      meal_plan: "three_meals", housing_support: "none",
    },
    q_work_schedule: {
      work_start_time: "09:00", work_end_time: "18:30", daily_idle_hours: 1,
      commute_hours: 0.75, work_days_per_week: 5, weekly_work_hours: 44,
      weekend_pattern: "double_off", travel_days_per_month: 0, travel_frequency: "none",
    },
    q_business_profile: {
      work_environment: "cbd", business_level: "core", business_growth_expectation: "steady_growth",
      business_affinity: 4, boss_resource_ability: "high", boss_ability: "medium",
    },
    q_health_profile: {
      boss_attitude: "good", kpi_pressure: "medium",
      communication_style: "conversational", expected_mental_state: "calm",
    },
  },
  {
    q_basic_profile: {
      city: "上海", city_affinity: 4, distance_from_home: "far_away",
      employment_nature: "foreign_company", is_outsourced: false,
    },
    q_income_base: {
      monthly_base: 8500, guaranteed_salary_months: 12,
      annual_bonus_method: "multiple", annual_bonus_value: 2, annual_bonus_months: 2,
      social_security_type: "salary", housing_fund_base_type: "salary",
      housing_fund_employee_rate: 7, housing_fund_employer_rate: 7,
      special_additional_deductions: ["rent"],
    },
    q_benefits: {
      signing_bonus: 0, monthly_subsidies: 400,
      meal_plan: "two_meals", housing_support: "none",
    },
    q_work_schedule: {
      work_start_time: "09:30", work_end_time: "18:30", daily_idle_hours: 1,
      commute_hours: 0.75, work_days_per_week: 5, weekly_work_hours: 40,
      weekend_pattern: "double_off", travel_days_per_month: 1, travel_frequency: "monthly_le1",
    },
    q_business_profile: {
      work_environment: "office", business_level: "innovative", business_growth_expectation: "fast_growth",
      business_affinity: 5, boss_resource_ability: "medium", boss_ability: "high",
    },
    q_health_profile: {
      boss_attitude: "average", kpi_pressure: "medium",
      communication_style: "conversational", expected_mental_state: "tense",
    },
  },
  {
    q_basic_profile: {
      city: "成都", city_affinity: 4, distance_from_home: "neighboring_province",
      employment_nature: "state_owned", is_outsourced: false,
    },
    q_income_base: {
      monthly_base: 6500, guaranteed_salary_months: 12,
      annual_bonus_method: "amount", annual_bonus_value: 6500,
      social_security_type: "salary", housing_fund_base_type: "salary",
      housing_fund_employee_rate: 12, housing_fund_employer_rate: 12,
      special_additional_deductions: [],
    },
    q_benefits: {
      signing_bonus: 0, monthly_subsidies: 300,
      meal_plan: "one_meal", housing_support: "dorm",
    },
    q_work_schedule: {
      work_start_time: "09:00", work_end_time: "18:00", daily_idle_hours: 1,
      commute_hours: 0.5, work_days_per_week: 5, weekly_work_hours: 40,
      weekend_pattern: "double_off", travel_days_per_month: 0, travel_frequency: "none",
    },
    q_business_profile: {
      work_environment: "office", business_level: "normal", business_growth_expectation: "no_growth",
      business_affinity: 3, boss_resource_ability: "medium", boss_ability: "medium",
    },
    q_health_profile: {
      boss_attitude: "unclear", kpi_pressure: "no_kpi",
      communication_style: "unclear", expected_mental_state: "relaxed",
    },
  },
];
/** 与 question-parts.serverFieldDraft 同口径的最小只读检查：
 * 该字段在服务端是否已有作答（含 unknown / not_applicable）。 */
function serverAnswered(q: RenderedQuestion, oid: string, fk: string): boolean {
  const st = q.offers?.[oid];
  if (!st) return false;
  const status = st.statuses?.[fk] ?? (st.values && fk in st.values ? "known" : undefined);
  return status === "known" || status === "unknown"
    || status === "need_confirmation" || status === "not_applicable";
}

/** 把示例值预填进本地草稿：只填空字段，返回新草稿与填充的字段数。
 *  questions 传完整目录；示例画像未声明的题自然跳过。 */
export function buildSampleDrafts(
  questions: RenderedQuestion[],
  offers: Pick<OfferResource, "offer_id">[],
  current: NodeDraft,
): { next: NodeDraft; filled: number } {
  const next: NodeDraft = { ...current };
  let filled = 0;
  for (const q of questions) {
    for (const [oi, o] of offers.entries()) {
      // 画像按 Offer 顺序取（第 3 份之后循环）；未声明该题的画像自然跳过
      const values = SAMPLE_PROFILES[oi % SAMPLE_PROFILES.length][q.question_key];
      if (!values) continue;
      const prevNode = next[q.question_key] ?? {};
      const perOffer = { ...(prevNode[o.offer_id] ?? {}) };
      let changed = false;
      for (const f of q.fields ?? []) {
        if (perOffer[f.field_key]) continue; // 已有本地草稿，不覆盖
        if (serverAnswered(q, o.offer_id, f.field_key)) continue; // 服务端已答，不覆盖
        if (!(f.field_key in values)) continue;
        perOffer[f.field_key] = { status: "known", value: values[f.field_key] } satisfies FieldDraft;
        changed = true;
        filled += 1;
      }
      if (changed) {
        next[q.question_key] = { ...prevNode, [o.offer_id]: perOffer };
      }
    }
  }
  return { next, filled };
}
