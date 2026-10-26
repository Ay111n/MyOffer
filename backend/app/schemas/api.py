from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.domain.contracts import IncomeBreakdown, RawFactInput, UserPreferenceInput


class ErrorBody(BaseModel): code:str; message:str; details:dict[str,Any]=Field(default_factory=dict)
class ErrorResponse(BaseModel): error:ErrorBody
class DecisionEcho(BaseModel):
    """写入响应中的最新报告摘要（与结果页同一快照产出）。

    ranking_top_offer_id 是综合评分第一的 Offer；overall_scores 以
    offer_id 字符串为键。"""
    snapshot_seq:int
    ranking_top_offer_id:UUID|None=None
    overall_scores:dict[str,float]=Field(default_factory=dict)
    weights:dict[str,float]=Field(default_factory=dict)
class DeletedResource(BaseModel): deleted:bool=True
class DeletedResponse(BaseModel): data:DeletedResource

# ── 参考数据（规则层定义，前端选项等的唯一出口）────────────────────
class PreferenceDimensionResource(BaseModel):
    label:str
    description:str

class PreferenceQuestionOption(BaseModel):
    value:str
    label:str

class PreferenceQuestionResource(BaseModel):
    question_id:str
    # single = 用户级情境题（如购房意向），渲染为普通选项题但不参与权重积分
    kind:Literal['pairwise','calibration','single']
    prompt:str
    left_dimension:str|None=None
    right_dimension:str|None=None
    options:list[PreferenceQuestionOption]=Field(default_factory=list)

class PreferenceQuestionnaireResource(BaseModel):
    version:str
    title:str
    subtitle:str
    estimated_minutes:int
    dimensions:dict[str,PreferenceDimensionResource]=Field(default_factory=dict)
    questions:list[PreferenceQuestionResource]=Field(default_factory=list)

class FieldBoundsResource(BaseModel): min:float|None=None; max:float|None=None

class FieldRulesResource(BaseModel):
    """字段注册表的 UI 契约（fields.yaml 唯一事实源，前端禁止手抄）。"""
    required_core_fields:list[str]=Field(default_factory=list)
    bounds:dict[str,FieldBoundsResource]=Field(default_factory=dict)

class MetaResource(BaseModel):
    supported_cities:list[str]=Field(default_factory=list)
    # 城市 → 线级标签（一线/新一线/…，city_index.yaml tier 键唯一事实源），
    # 供前端城市下拉分组展示；键集与 supported_cities 一致
    city_tiers:dict[str,str]=Field(default_factory=dict)
    preference_questionnaire:PreferenceQuestionnaireResource
    # 未做问卷时的综合评分默认权重（preferences.yaml default_weights，唯一事实源）
    default_weights:dict[str,float]=Field(default_factory=dict)
    # 数值边界与 core 必需度字段（fields.yaml 唯一事实源）
    field_rules:FieldRulesResource=Field(default_factory=FieldRulesResource)
class MetaResponse(BaseModel): data:MetaResource

class SessionCreateRequest(BaseModel): title:str|None=Field(default=None, max_length=200)
class SessionResource(BaseModel): session_id:UUID; title:str|None=None; phase:str='completion'; offer_count:int=0; latest_snapshot_seq:int|None=None; pending_confirmations:int=0; created_at:datetime; updated_at:datetime
class SessionResponse(BaseModel): data:SessionResource

class FactResource(BaseModel): value:Any|None=None; status:str='known'; source:str; reliability:float|None=None
class OfferCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
class FactPatch(BaseModel):
    # field_key/source 上限：字段键是短标识符，超长输入只会以 422 文案回显——
    # 在入口截断，避免回显放大（与 fact_validation._echo 同一防线）
    field_key:str = Field(max_length=100)
    value:Any
    source:str|None = Field(default=None, max_length=100)
    note:str|None=Field(default=None, max_length=1000)
class OfferPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version:int
    # 身份改名（选填）：company 提供 strip 后不得为空（标签与报告靠它做主标识）；
    # position 传空串表示清除岗位。长度上限与 report_tools.validate_restore 一致。
    company:str|None=Field(default=None, max_length=200)
    position:str|None=Field(default=None, max_length=200)
    facts:list[FactPatch]=Field(default_factory=list, max_length=80)
class OfferResetRequest(BaseModel): version:int=Field(ge=1)
class OfferResource(BaseModel):
    offer_id:UUID; display_order:int; company:str; position:str; version:int; facts:dict[str,FactResource]=Field(default_factory=dict)
class OfferResponse(BaseModel): data:OfferResource
class OfferListResponse(BaseModel): data:list[OfferResource]
class OfferMutationResponse(BaseModel): data:OfferResource|DeletedResource; decision:DecisionEcho

class PreferenceAnswer(BaseModel):
    question_id:str=Field(min_length=1)
    choice:str=Field(min_length=1)

class PreferencePutRequest(BaseModel):
    """偏好写入：问卷计算权重，或提交手动权重及可选问卷答案。"""
    model_config = ConfigDict(extra="forbid")
    version:int=1
    source:Literal['questionnaire','manual']='questionnaire'
    # manual 至少携带 weights；若同时携带答案，须附当前问卷版本与全部答案
    questionnaire_version:str|None=None
    answers:list[PreferenceAnswer]=Field(default_factory=list)
    weights:dict[str,float]|None=None

class PreferenceResource(BaseModel):
    weights:dict[str,float]=Field(default_factory=dict)
    version:int=0
    source:Literal['default','questionnaire','manual']='questionnaire'
    questionnaire_version:str|None=None
    answers:list[PreferenceAnswer]=Field(default_factory=list)
class PreferenceMutationResponse(BaseModel): data:PreferenceResource; decision:DecisionEcho
class PreferenceResponse(BaseModel): data:PreferenceResource|None=None; decision:DecisionEcho

class OptionItem(BaseModel): value:Any; label:str
class RenderField(BaseModel):
    field_key:str
    value_type:str
    evidence_category:str|None=None
    allowed_sources:list[str]=Field(default_factory=list)
    options:list[OptionItem]=Field(default_factory=list)
    # 信息收集页显示元数据：默认值用于首屏预设，ui_group/ui_role
    # 将底层事实拼成图片中的同一行双值输入。
    default_value:Any|None=None
    ui_group:str|None=None
    ui_role:str|None=None
class OfferQuestionState(BaseModel): status:str='unanswered'; values:dict[str,Any]=Field(default_factory=dict); statuses:dict[str,str]=Field(default_factory=dict); prefill:dict[str,Any]=Field(default_factory=dict)
class RenderedQuestion(BaseModel):
    question_key:str; section:str|None=None; prompt:str; comparison_mode:str; answer_type:str
    unknown_allowed:bool=True; fields:list[RenderField]=Field(default_factory=list); offers:dict[str,OfferQuestionState]=Field(default_factory=dict)
    recommended_sources:list[str]=Field(default_factory=list)
class QuestionArea(BaseModel):
    """按板块/轮次分组的问题目录节点。"""
    key:str; label:str; round:int=1; description:str=''; questions:list[RenderedQuestion]=Field(default_factory=list)
class QuestionsCatalogData(BaseModel): phase:str='completion'; areas:list[QuestionArea]
class QuestionsCatalogResponse(BaseModel): data:QuestionsCatalogData
class FieldAnswer(BaseModel):
    """field-level 作答契约：composite 问题内部各字段状态独立表达。

    known → value 必填，source 可选（缺省 user_provided，显式携带则校验来源表）；
    unknown → value 必须为空；
    not_applicable → 依赖字段不适用，value/source 必须为空；
    need_confirmation → value 可携带候选值，source 可选（同上缺省）。
    未提交的 output 不创建 RawFact（"没问到"≠"问过但不知道"）。
    """
    field_key:str = Field(max_length=100)
    status:Literal['known','unknown','need_confirmation','not_applicable']
    # note 上限与 FactPatch 对齐：note 直落 raw_facts 与快照 payload（进程内存）
    value:Any|None=None; source:str|None=Field(default=None, max_length=100); note:str|None=Field(default=None, max_length=1000)
class AnswerItem(BaseModel):
    offer_id:UUID|None=None    # per_session 问题为 None
    # 三维扩展后的经济信息题包含 23 个字段，保留少量扩展空间。
    fields:list[FieldAnswer]=Field(default_factory=list, max_length=32)
class AnswerRequest(BaseModel): answers:list[AnswerItem]=Field(max_length=8)
class AnswerData(BaseModel): question_key:str; states:dict[str,str]
class AnswerResponse(BaseModel): data:AnswerData; decision:DecisionEcho

class BatchAnswerItem(BaseModel):
    """单题草稿：answers 语义与单题端点完全一致（每 Offer 至多一条）。"""
    question_key:str = Field(max_length=100)
    answers:list[AnswerItem]=Field(max_length=8)
class BatchAnswerRequest(BaseModel):
    """多题草稿一次性提交（「生成对比报告」路径）：同一事务内逐题校验写入，
    全部成功后只重算一次、只落一条快照。任一题校验失败整批拒绝（原子，
    此时尚无任何写入），错误 details 附 question_key 供前端定位。"""
    items:list[BatchAnswerItem]=Field(min_length=1, max_length=16)
class BatchAnswerData(BaseModel):
    # question_key → (offer_id|None 的字符串) → 聚合状态
    questions:dict[str,dict[str,str]]=Field(default_factory=dict)
class BatchAnswerResponse(BaseModel): data:BatchAnswerData; decision:DecisionEcho
class StopData(BaseModel): phase:Literal['results']='results'
class StopResponse(BaseModel):
    data:StopData; decision:DecisionEcho


class ResumeData(BaseModel):
    phase:Literal['completion']='completion'


class ResumeResponse(BaseModel):
    data:ResumeData; decision:DecisionEcho


# ── Results projection（只读快照，禁止重新 evaluate）─────────────
class ModuleScoreView(BaseModel):
    """模块分 + 中文等级。"""
    score:float|None=None
    grade:str='待补充'

class MonthSalaryRowView(BaseModel):
    month:int; tax_pre:float; tax:float; after_tax:float

class InsuranceItemView(BaseModel):
    item:str; personal:float; employer:float

class SalaryModuleView(ModuleScoreView):
    income:IncomeBreakdown=Field(default_factory=IncomeBreakdown)
    monthly_rows:list[MonthSalaryRowView]=Field(default_factory=list)
    monthly_after_tax_avg:float|None=None
    annual_after_tax:float|None=None
    annual_bonus_after_tax:float|None=None
    bonus_tax_method:str|None=None
    signing_bonus_after_tax:float|None=None
    hf_annual:float|None=None
    annual_tax:float|None=None
    welfare_annual:float|None=None
    annual_with_welfare:float|None=None

class InsuranceModuleView(ModuleScoreView):
    items:list[InsuranceItemView]=Field(default_factory=list)
    personal_monthly:float|None=None
    employer_monthly:float|None=None
    total_monthly:float|None=None

class HousingModuleView(ModuleScoreView):
    down_payment:float|None=None
    down_payment_years:float|None=None
    payment_income_ratio:float|None=None
    monthly_payment:float|None=None
    welfare_annual:float|None=None
    signing_bonus:float|None=None

class OfferReportView(BaseModel):
    offer_id:UUID; company:str; position:str; display_order:int
    city:str|None=None
    monthly_after_tax:float|None=None
    overall_score:float|None=None
    overall_rank:int|None=None
    dimension_scores:dict[str,float|None]=Field(default_factory=dict)
    effective_weights:dict[str,float]=Field(default_factory=dict)
    score_contributions:dict[str,float]=Field(default_factory=dict)
    key_numbers:dict[str,float|None]=Field(default_factory=dict)
    sub_scores:dict[str,float]=Field(default_factory=dict)
    sub_metrics:dict[str,float|None]=Field(default_factory=dict)
    sub_details:dict[str,dict[str,Any]]=Field(default_factory=dict)
    missing_core:list[str]=Field(default_factory=list)
    known_optional:dict[str,Any]=Field(default_factory=dict)
    input_values:dict[str,Any]=Field(default_factory=dict)
    city_data_as_of:str|None=None
    compliance_alert:bool=False
    salary:SalaryModuleView
    insurance:InsuranceModuleView
    housing:HousingModuleView

class SensitivityFlip(BaseModel):
    """某个维度的权重调到 flip_weight 时，当前第一名不再是唯一第一。"""
    dimension:str; current_weight:float; flip_weight:float
    direction:Literal["up","down"]
    overtaken_by:UUID
    ties:bool=False

class SensitivityView(BaseModel):
    """排名对「偏好权重」的敏感性。status：stable 整个可选权重平面内都不变；
    steady 距翻转边界 ≥ 20 个百分点；moderate 10–20；fragile < 10；tie 当前就并列。
    margin 是当前权重到翻转边界的最短「总变差距离」——把多少个百分点从一个
    维度挪到另一个维度（二维全向扫描，不限于单轴）；stable 时为 None。"""
    status:Literal["stable","steady","moderate","fragile","tie"]
    leader_id:UUID|None=None
    nearest:SensitivityFlip|None=None
    flips:list[SensitivityFlip]=Field(default_factory=list)
    margin:float|None=None
    weight_min:float=0.05
    weight_max:float=0.9

class ResultView(BaseModel):
    """八模块对比报告（竞品对齐口径）。

    weights：决策维度权重（问卷产出）；ranking：综合评分降序的 offer id；
    insights：模块 key → 服务端生成的洞察文案；
    city_data_version：城市参考数据（费率/房价/生活成本）的版本标注。"""
    snapshot_seq:int; computed_at:datetime; rule_version:str; trigger_type:str
    weights:dict[str,float]=Field(default_factory=dict)
    ranking:list[UUID]=Field(default_factory=list)
    overall_scores:dict[str,float]=Field(default_factory=dict)
    city_data_version:str|None=None
    offers:list[OfferReportView]=Field(default_factory=list)
    insights:dict[str,str]=Field(default_factory=dict)
    summary:str=""
    attribution:dict[str,float]=Field(default_factory=dict)
    comparison_note:str=""
    tradeoff:str=""
    sensitivity:SensitivityView|None=None
class ResultResponse(BaseModel): data:ResultView
class HistoryItem(BaseModel): seq:int; created_at:datetime; trigger_type:str; top_offer_id:UUID|None=None; top_score:float|None=None
class HistoryResponse(BaseModel): data:list[HistoryItem]

# ── telemetry：匿名事件批量上报 ─────────────────────────────────
class TelemetryEventIn(BaseModel):
    event_type:str
    payload:dict[str,Any]=Field(default_factory=dict)
    client_ts:datetime|None=None
class TelemetryBatchRequest(BaseModel):
    events:list[TelemetryEventIn]=Field(min_length=1,max_length=50)
class TelemetryBatchResponse(BaseModel): data:dict[str,int]
class DueDiligenceItem(BaseModel):
    id:UUID; offer_id:UUID|None=None; question_key:str|None=None; content:str
    suggested_source:str|None=None; status:Literal['open','done','dismissed']
    still_relevant:bool=True
class DueDiligenceResponse(BaseModel): data:dict[str,list[DueDiligenceItem]]
class DueDiligencePatchRequest(BaseModel): status:Literal['open','done','dismissed']
class DueDiligencePatchResponse(BaseModel): data:DueDiligenceItem


class ReportScenarioRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    snapshot_seq: int = Field(ge=1)
    offer_id: UUID
    monthly_base: float | None = Field(default=None, gt=0, le=1_000_000)
    bonus_factor: float = Field(default=1, ge=0, le=2)
    weekly_work_hours: float | None = Field(default=None, gt=0, le=168)
    commute_minutes: float | None = Field(default=None, ge=0, le=240)
    weights: dict[str, float] | None = None


class ReportScenarioSolveRequest(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    snapshot_seq: int = Field(ge=1)
    offer_id: UUID


class ParitySolution(BaseModel):
    """反解追平点：目标 Offer 的某项输入谈到多少，展示综合分追平当前第一名。
    required_value=None 表示在字段上界内仅靠该杠杆无法追平。"""
    lever: Literal["monthly_base"] = "monthly_base"
    target_id: UUID
    leader_id: UUID
    leader_score: float
    target_current_score: float
    current_value: float
    required_value: float | None = None
    delta: float | None = None


class ScenarioSolveResponse(BaseModel): data: ParitySolution


class PortableOfferInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    offer_id: UUID
    display_order: int
    # 身份名随归档携带（改名入口的成果不因导出/导入丢失）；旧版归档没有
    # 这两个键——缺省空名，导入时兜底为槽位默认命名（sessions.restore）
    company: str = Field(default="", max_length=200)
    position: str = Field(default="", max_length=200)
    facts: dict[str, RawFactInput] = Field(default_factory=dict)


class PortableDecisionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    offers: list[PortableOfferInput]
    preferences: UserPreferenceInput


class ReportArchive(BaseModel):
    format: Literal["myoffer-input-v5"] = "myoffer-input-v5"
    schema_version: Literal[5] = 5
    inputs: PortableDecisionInput


class ReportRestoreRequest(BaseModel):
    format: str
    schema_version: int | None = None
    inputs: PortableDecisionInput | None = None
