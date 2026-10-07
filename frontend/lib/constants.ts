/** 产品级常量：决策维度（键为后端 DimensionKey，标签与价值观问卷一致）。v0.8 */
export const DIMENSIONS: { key: string; label: string; short: string }[] = [
  { key: "economic", label: "经济回报", short: "经济" },
  { key: "growth", label: "职业成长", short: "成长" },
  { key: "experience", label: "工作体验", short: "体验" },
];

export function dimLabel(key: string): string {
  return DIMENSIONS.find((d) => d.key === key)?.label ?? key;
}

/** 综合评分权重条的展示顺序（与问卷校准题的选项一致）。 */
export const WEIGHT_ORDER = ["economic", "growth", "experience"] as const;

/** 对比报告的 8 大模块（顺序即页面渲染顺序）；method 为「怎么算的」口径说明文案。 */
export const REPORT_MODULES: { key: string; index: number; title: string; tagline: string; method: string }[] = [
  {
    key: "salary", index: 1, title: "税后薪资", tagline: "到手才是真收入",
    method: "收入分为入职一次性收入、常规年度现金收入、年度福利。固定工资与现金补贴按完整年度计税，年终奖择优估算；入职收入按增加后的年度总税差估算。薪资评分采用常规年度税后现金与年度福利的合计，不含入职收入。",
  },
  {
    key: "insurance", index: 2, title: "五险一金", tagline: "单位给你交了多少",
    method: "各险种月缴 = 缴费基数 × 城市参考费率；公积金 = 缴存基数 × 填报比例。模块分按个人与单位月缴合计占月薪的比例计算。公积金分个人、单位账户缴存展示，不作为现金到账。",
  },
  {
    key: "efficiency", index: 3, title: "赚钱效率", tagline: "工作性价比 · 摸鱼强度",
    method: "现金时薪 = 常规年度税后现金 ÷（周工时 × 52），不含入职一次性收入、公积金和实物福利。日薪 = 时薪 × 日均工时；摸鱼收益率 = 每日摸鱼时长 ÷ 日均在岗时长，上限 80%。",
  },
  {
    key: "housing", index: 4, title: "买房预期", tagline: "多久能买房 · 月供压力大不大",
    method: "房价、面积、首付比例和贷款参数采用城市参考值；攒首付年限 = 首付 ÷（常规年度税后现金 × 45% 储蓄率）。月供收入比使用常规年度税后现金的月均值。入职收入、公积金和实物福利不计入储蓄现金。",
  },
  {
    key: "living", index: 5, title: "生活水平", tagline: "工资在当地算什么水平",
    method: "月均现金 = 常规年度税后现金 ÷ 12（含按填写值估算的年度奖金）。收入倍数 = 月均现金 ÷ 当地平均工资；购买力 = 月均现金 ÷ 城市物价系数；舒适距离 = 月均现金 − 当地平均工资 × 物价系数 × 1.5。城市缺失时采用全国参考值。",
  },
  {
    key: "development", index: 6, title: "发展水平", tagline: "未来成长空间",
    method: "八轴雷达取均分：城市等级来自城市参考分；其余七轴（业务/老板/沟通等）按你的主观评估映射打分，「不清楚」计中性 50 分。轴值来自面试阶段的印象，分数仅供参考，不宜作为唯一依据。",
  },
  {
    key: "stability", index: 7, title: "稳定性", tagline: "工作稳不稳",
    method: "稳定性 = 周工作天数（50%）+ KPI 压力（50%）加权 − 外包折减 25 分。管饭/管住已折现进薪资模块的福利，这里不再重复计分。注意：本模块衡量的是工作节奏与制度压力，不涵盖裁员与经营风险。",
  },
  {
    key: "health", index: 8, title: "健康损耗", tagline: "加班和压力伤身体吗",
    method: "健康分 = 100 − 损耗分；损耗分 = 工时 + 周末 + 通勤 + 出差 + 精神状态的扣分之和。未作答项按中性档扣分（填了不吃亏），工时/通勤缺失时模块整体待补充。KPI 与工作天数的制度面归稳定性模块，不在此重复扣分。",
  },
];

/** 报告页字段级口径提示（标签后 ⓘ 悬停/聚焦展示），文案与 REPORT_MODULES 的 method 口径保持一致。 */
export const REPORT_FIELD_TIPS = {
  idle_ratio: "摸鱼收益率 = 每日摸鱼时长 ÷ 日均在岗时长 × 100%。数值越高越「爽」，也可能说明工作不饱和——本工具按 80% 封顶。",
  hf_annual: "公积金年缴存 =（个人 + 单位）月缴 × 12。个人部分已从现金工资扣除；账户积累单列为福利，不等于当期现金到账。",
  welfare_annual: "餐食与住宿按参考替代成本折现，不包含年度现金补贴；现金补贴已进入常规年度现金收入。",
  income_multiple: "收入倍数 = 月均到手 ÷ 当地平均工资（全口径社平 = 社保基数上限 ÷ 3）。1.34× 即比当地平均高 34%，越低越低于当地平均线；未填城市时按全国平均 8,000 元/月计算。",
  purchasing_power: "实际购买力 = 月均到手 ÷ 当地物价系数（城市生活成本估算 ÷ 全国基准 3,000，全国平均 = 1）。物价越高的城市，同样的工资购买力越低。",
  comfort_gap: "舒适距离 = 月均到手 − 舒适线；舒适线 = 当地平均工资 × 物价系数 × 1.5。正数 = 已超过舒适门槛、有余量；负数 = 还差这么多才到舒适生活线。",
} as const;

/** Offer 身份色：A 蓝 / B 赭 / C 紫（低饱和，色盲可区分，且始终配字母），之后循环。 */
export const OFFER_COLORS = ["#2f5f8f", "#a8602a", "#6b5a94", "#4a7a6b", "#8a6a3a"] as const;

export function offerColor(index: number): string {
  return OFFER_COLORS[(index - 1 + OFFER_COLORS.length) % OFFER_COLORS.length] ?? OFFER_COLORS[0];
}

/** 明细页标题：公司名与「Offer X」占位名相同时不重复拼接。 */
export function offerHeading(displayOrder: number, company: string): string {
  const letter = String.fromCharCode(64 + displayOrder);
  return company === `Offer ${letter}` ? `Offer ${letter}` : `Offer ${letter} · ${company}`;
}

/** Offer 浅色背景（对比表格列头 / 明细页 tab）。 */
export const OFFER_SOFT_COLORS = ["#e8eff6", "#f6ebe0", "#eeeaf5", "#e6efec", "#f1ebdd"] as const;

export function offerSoftColor(index: number): string {
  return OFFER_SOFT_COLORS[(index - 1 + OFFER_SOFT_COLORS.length) % OFFER_SOFT_COLORS.length] ?? OFFER_SOFT_COLORS[0];
}

/** 五险一金堆叠条语义色（个人 / 单位两段），条形与图例同源。 */
export const INSURANCE_SEG_COLORS = { personal: "#2a665a", employer: "#bcd8d1" } as const;

/** 字段 key → 中文名（与后端 rules/fields.yaml 对应） */
export const FIELD_LABELS: Record<string, string> = {
  company: "公司",
  position: "岗位",
  city: "工作城市",
  monthly_base: "税前月薪",
  guaranteed_salary_months: "固定薪数",
  annual_bonus_months: "年终奖月数",
  bonus_certainty: "奖金确定性",
  signing_bonus: "签字及安家费",
  government_talent_subsidy: "政府人才补贴",
  monthly_subsidies: "各项补贴汇总",
  housing_fund_employee_rate: "公积金比例",
  housing_fund_employer_rate: "公积金公司缴存比例",
  housing_fund_base: "公积金缴存基数",
  monthly_necessary_expense: "月必要生活支出",
  housing_support: "管住吗",
  housing_support_value: "住房支持金额",
  work_content_type: "工作内容类型",
  actual_work_description: "实际工作描述",
  jd_match_level: "岗位内容匹配度",
  entry_scope: "新人职责范围",
  repetitive_work_level: "重复工作占比",
  autonomy_level: "自主性",
  problem_complexity_level: "问题复杂度",
  mentorship: "带教机制",
  feedback_cadence: "反馈频率",
  core_skill: "核心技能",
  skill_transferability: "技能通用性",
  skill_market_demand: "技能市场需求",
  strategic_position: "业务战略地位",
  business_trend_status: "业务发展趋势",
  team_headcount_trend: "团队人数趋势",
  layoff_level: "裁员情况",
  performance_pressure: "绩效压力",
  official_hours_policy: "工时制度",
  weekly_work_hours: "周工作时长",
  weekend_pattern: "周末模式",
  oncall_cadence: "On-call 频率",
  overtime_night: "工作日晚加班",
  commute_minutes: "单程通勤时间",
  travel_frequency: "出差频率",
  remote_policy: "远程政策",
  company_competitiveness: "公司竞争力",
  industry_outlook: "行业景气度",
  city_affinity: "城市喜爱度",
  distance_from_home: "离家远近",
  employment_nature: "工作性质",
  is_outsourced: "外包 / 派遣",
  annual_bonus_method: "年终奖方式",
  annual_bonus_value: "年终奖金额",
  social_security_type: "社保缴纳类型",
  social_security_base: "社保缴纳基数",
  housing_fund_base_type: "公积金缴纳类型",
  special_additional_deductions: "专项附加扣除",
  meal_plan: "管饭吗",
  work_start_time: "上班时间",
  work_end_time: "下班时间",
  daily_idle_hours: "摸鱼时间",
  commute_hours: "通勤(单程)",
  work_days_per_week: "周工作天数",
  travel_days_per_month: "出差频率",
  work_environment: "工作环境",
  business_level: "业务范围",
  business_growth_expectation: "业务增长预期",
  business_affinity: "业务喜爱度",
  boss_resource_ability: "老板资源能力",
  boss_ability: "老板能力",
  entrepreneurial: "是否商系",
  bossless: "没有老板",
  boss_attitude: "老板态度",
  kpi_pressure: "kpi压力",
  speaking_hours_per_day: "说话时长",
  communication_style: "说话状态",
  expected_mental_state: "预期精神状态",
  probation_months: "试用期月数",
  probation_pay_percent: "试用期工资比例",
  annual_raise_percent: "约定年度调薪",
  relocation_grant: "搬迁安置补助",
  supplementary_medical_value: "补充医疗年度价值",
  overtime_comp_annual: "年度加班值班补偿",
  training_days_year: "年度培训天数",
  training_budget_year: "年度培训预算",
  internal_mobility: "内部轮岗转岗",
  portfolio_permission: "成果展示许可",
  ai_tool_access: "AI 工具使用",
  user_impact_exposure: "用户与业务结果接触",
  goal_skill_fit: "与个人目标的契合度",
  project_stage: "项目阶段",
  peak_week_hours: "旺季每周工时",
  peak_weeks_year: "年度旺季周数",
  after_hours_response: "下班后响应频率",
  remote_days_week: "每周远程天数",
  flex_schedule: "弹性工作时间",
  extra_paid_leave: "额外带薪假期",
  meeting_load: "会议与临时任务",
  manager_support: "直属主管支持",
  team_speakup: "团队表达氛围",
  work_meaning: "工作认同感",
  side_project_policy: "个人项目限制",
  weekend_overtime_days_month: "每月周末加班天数",
  workspace_comfort: "办公环境舒适度",
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

/** 金额：千分位整数（元）。 */
export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/** 金额：≥1 万显示「X.X 万」，否则显示整数元。 */
export function fmtWan(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(digits)} 万`;
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}

/** 金额（元）拆成数值与单位：≥1 万以「万」计，否则以「元」计；单位单独返回，供表格统一小字渲染。 */
export function fmtMoneyParts(v: number | null | undefined): { text: string; unit: string } {
  if (v === null || v === undefined) return { text: "—", unit: "" };
  if (Math.abs(v) >= 10000) return { text: (v / 10000).toFixed(1), unit: "万" };
  return { text: v.toLocaleString("zh-CN", { maximumFractionDigits: 0 }), unit: "元" };
}

/** 等级的四档语义色（红绿灯梯度）：excellent=绿 / good=黄绿 / fair=琥珀 / poor=红。
 *  取值与 backend/rules/report.yaml 各模块 grades 分档对齐；未收录的词（如「待补充」）回退灰色。 */
export type GradeTone = "excellent" | "good" | "fair" | "poor";

const GRADE_TONES: Record<string, GradeTone> = {
  // 各模块第一档
  很高: "excellent", 充足: "excellent", 高效: "excellent", 轻松: "excellent",
  宽裕: "excellent", 潜力大: "excellent", 很稳: "excellent", 损耗低: "excellent",
  // 第二档
  较高: "good", 较足: "good", 尚可: "good", 够花: "good", 较好: "good", 较稳: "good", 损耗中: "good",
  // 第三档（琥珀）：中性描述
  中等: "fair", 有压力: "fair", 需留意: "fair",
  // 第四档（红）：行动建议式委婉表达
  有空间: "poor", 待加强: "poor", 待提升: "poor", 需规划: "poor", 需节流: "poor", 待观察: "poor", 有变数: "poor", 需调整: "poor",
};

export function gradeTone(grade: string | null | undefined): GradeTone | undefined {
  return grade ? GRADE_TONES[grade] : undefined;
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  return v.toFixed(digits);
}

/** 比例（0-1）→ 百分数文本。 */
export function fmtPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
