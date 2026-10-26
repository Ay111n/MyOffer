/** 示例数据画像（「填入示例数据」按钮 / 「先看一份示例报告」一键演示）。
 *
 *  设计目标（数值经引擎锁定，改动前请用两态验收指标回归）：
 *  - 三份 Offer 维度互搏：A 星澜科技（北京，经济+成长强、强度高）、
 *    B 蓉创信息（成都，体验最舒适、成长一般）、C 浦海数据（上海，成长第一）；
 *  - 默认权重（考虑买房）下 A 以约 1.2–1.5 分微弱领先，敏感性 fragile
 *    （margin ≈ 5 个百分点）——「难以区分，但仍有差距」；
 *  - 顺带触发功能面：B 按最低基数缴费（合规告警 + 评分参考现金双轨）、
 *    旺季工时只在 B/C 填写（部分可比提示 + NextSteps 深链）、
 *    A 倍数年终 / B、C 金额年终（两种计税口径）、三城购房压力差异。
 *
 *  薪资锚来自公开校招信息（见 docs/EXAMPLE_OFFER_SOURCES.md），其余字段为
 *  构造的教学示例；公司名为虚构，不对应真实公司。
 *  只填空白项、不覆盖用户已填内容（填充逻辑见 complete 页的 fillExamples）。 */

/** demo 专用身份（一键示例时写入公司/岗位名；「填入示例数据」不使用）。 */
export const EXAMPLE_META: { company: string; position: string }[] = [
  { company: "星澜科技", position: "后端开发" },
  { company: "蓉创信息", position: "后端开发" },
  { company: "浦海数据", position: "软件开发" },
];

export const EXAMPLE_OFFERS: Record<string, unknown>[] = [
  { city: "北京", monthly_base: 15000, guaranteed_salary_months: 13, business_level: "core", entry_scope: "own_module", user_impact_exposure: "direct", weekly_work_hours: 50, work_days_per_week: 5, annual_bonus_method: "multiple", annual_bonus_value: 4, signing_bonus: 40000, monthly_subsidies: 800, meal_plan: "two_meals", housing_support: "none", social_security_type: "salary", housing_fund_base_type: "salary", housing_fund_employee_rate: 12, special_additional_deductions: ["rent"], mentorship: "informal", feedback_cadence: "occasional", commute_minutes: 50, travel_days_per_month: 0 },
  { city: "成都", monthly_base: 11000, guaranteed_salary_months: 13, business_level: "important", entry_scope: "small_feature", user_impact_exposure: "indirect", weekly_work_hours: 44, work_days_per_week: 5, annual_bonus_method: "amount", annual_bonus_value: 10000, signing_bonus: 0, monthly_subsidies: 300, meal_plan: "one_meal", housing_support: "none", social_security_type: "minimum", housing_fund_base_type: "minimum", housing_fund_employee_rate: 5, special_additional_deductions: ["rent"], mentorship: "formal", feedback_cadence: "formal_regular", commute_minutes: 45, travel_days_per_month: 0 },
  { city: "上海", monthly_base: 17000, guaranteed_salary_months: 12, business_level: "core", entry_scope: "own_module", user_impact_exposure: "direct", weekly_work_hours: 50, work_days_per_week: 5, annual_bonus_method: "amount", annual_bonus_value: 22000, signing_bonus: 0, monthly_subsidies: 500, meal_plan: "one_meal", housing_support: "none", social_security_type: "salary", housing_fund_base_type: "salary", housing_fund_employee_rate: 7, special_additional_deductions: ["rent"], mentorship: "assigned", feedback_cadence: "occasional", commute_minutes: 45, travel_days_per_month: 2 },
];

export const EXAMPLE_DETAILS: Record<string, unknown>[] = [
  { government_talent_subsidy: 0, probation_months: 3, probation_pay_percent: 100, annual_raise_percent: 5, relocation_grant: 0, supplementary_medical_value: 1200, overtime_comp_annual: 0, jd_match_level: "high_match", autonomy_level: "high", problem_complexity_level: "complex", skill_transferability: "high", training_days_year: 2, training_budget_year: 1000, internal_mobility: "available", portfolio_permission: "anonymized", ai_tool_access: "supported", goal_skill_fit: "high", project_stage: "scaling", oncall_cadence: "monthly_few", after_hours_response: "weekly", remote_days_week: 0, flex_schedule: "no", extra_paid_leave: 0, meeting_load: "moderate", manager_support: "high", team_speakup: "open", work_meaning: "high", side_project_policy: "allowed", weekend_overtime_days_month: 2, workspace_comfort: "good", performance_pressure: "stack_rank" },
  { government_talent_subsidy: 0, probation_months: 3, probation_pay_percent: 100, annual_raise_percent: 3, relocation_grant: 0, supplementary_medical_value: 1000, overtime_comp_annual: 0, jd_match_level: "high_match", autonomy_level: "frequent", problem_complexity_level: "analytical", skill_transferability: "high", training_days_year: 5, training_budget_year: 3000, internal_mobility: "available", portfolio_permission: "public", ai_tool_access: "allowed", goal_skill_fit: "high", project_stage: "scaling", peak_week_hours: 45, peak_weeks_year: 4, oncall_cadence: "none", after_hours_response: "occasional", remote_days_week: 1, flex_schedule: "yes", extra_paid_leave: 2, meeting_load: "light", manager_support: "high", team_speakup: "open", work_meaning: "medium", side_project_policy: "allowed", weekend_overtime_days_month: 0, workspace_comfort: "good", performance_pressure: "low_ratio" },
  { government_talent_subsidy: 0, probation_months: 3, probation_pay_percent: 100, annual_raise_percent: 8, relocation_grant: 0, supplementary_medical_value: 1000, overtime_comp_annual: 0, jd_match_level: "high_match", autonomy_level: "high", problem_complexity_level: "analytical", skill_transferability: "medium", training_days_year: 4, training_budget_year: 2500, internal_mobility: "available", portfolio_permission: "public", ai_tool_access: "allowed", goal_skill_fit: "high", project_stage: "mature", peak_week_hours: 52, peak_weeks_year: 6, oncall_cadence: "monthly_few", after_hours_response: "weekly", remote_days_week: 1, flex_schedule: "yes", extra_paid_leave: 2, meeting_load: "moderate", manager_support: "medium", team_speakup: "open", work_meaning: "high", side_project_policy: "allowed", weekend_overtime_days_month: 1, workspace_comfort: "good", performance_pressure: "low_ratio" },
];
