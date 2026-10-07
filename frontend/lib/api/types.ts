import type { components } from "./schema";

export type S = components["schemas"];
export type SessionResource = S["SessionResource"];
export type OfferResource = S["OfferResource"];
export type DecisionEcho = S["DecisionEcho"];
export type PreferenceResource = S["PreferenceResource"];
export type PreferenceAnswer = S["PreferenceAnswer"];
export type PreferenceQuestion = S["PreferenceQuestionResource"];
export type PreferenceQuestionnaireResource = S["PreferenceQuestionnaireResource"];
export type RenderedQuestion = S["RenderedQuestion"];
export type RenderField = S["RenderField"];
export type OptionItem = S["OptionItem"];
export type OfferQuestionState = S["OfferQuestionState"];
export type QuestionArea = S["QuestionArea"];
export type QuestionsCatalogData = S["QuestionsCatalogData"];
export type ResultView = S["ResultView"];
export type OfferReportView = S["OfferReportView"];
export type HistoryItem = S["HistoryItem"];
export type DueDiligenceItem = S["DueDiligenceItem"];
export type DueDiligenceItemView = S["DueDiligenceItem"];
export type FactResource = S["FactResource"];

/** 作答字段的前端本地状态（v0.2 减法：来源由后端统一记 user_provided，前端不再采集）。
 *  UI 上把「不知道」与「待确认」合并为单个「待定」，提交时统一按 unknown 发到后端。
 *  `note` 用来给「其他（补充说明）」类枚举选项附加自由文本（后端 AnswerItem 已支持）。 */
export type FieldDraft = {
  status: "known" | "pending" | "not_applicable";
  value?: unknown;
  note?: string;
};
