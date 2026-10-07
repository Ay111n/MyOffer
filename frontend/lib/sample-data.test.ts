import { describe, expect, it } from "vitest";

import { buildSampleDrafts, SAMPLE_CITIES } from "./sample-data";
import type { OfferResource, RenderedQuestion, RenderField } from "@/lib/api/types";
import type { NodeDraft } from "@/components/question-parts";

function field(field_key: string, value_type = "number"): RenderField {
  return { field_key, value_type };
}

function question(question_key: string, fields: RenderField[]): RenderedQuestion {
  return {
    question_key,
    prompt: question_key,
    comparison_mode: "per_offer",
    answer_type: "composite",
    unknown_allowed: true,
    fields,
  } as RenderedQuestion;
}

const OFFER_A = { offer_id: "offer-a" } as OfferResource;
const OFFER_B = { offer_id: "offer-b" } as OfferResource;
const OFFER_C = { offer_id: "offer-c" } as OfferResource;

const QUESTIONS = [
  question("q_basic_profile", [field("city", "text"), field("city_affinity")]),
  question("q_income_base", [field("monthly_base", "money"), field("annual_bonus_method", "enum"), field("annual_bonus_value")]),
  question("q_health_profile", [field("boss_attitude", "enum")]),
  // 示例画像未声明的题：应整体跳过
  question("q3_actual_work", [field("actual_work_description", "text")]),
];

describe("buildSampleDrafts", () => {
  it("按 Offer 顺序填入六区画像，只覆盖画像声明过的字段", () => {
    const { next, filled } = buildSampleDrafts(QUESTIONS, [OFFER_A, OFFER_B, OFFER_C], {});

    const aCity = next.q_basic_profile?.[OFFER_A.offer_id]?.city;
    const bCity = next.q_basic_profile?.[OFFER_B.offer_id]?.city;
    expect(aCity).toEqual({ status: "known", value: SAMPLE_CITIES[0] });
    expect(bCity).toEqual({ status: "known", value: SAMPLE_CITIES[1] });
    const cCity = next.q_basic_profile?.[OFFER_C.offer_id]?.city;
    expect(cCity).toEqual({ status: "known", value: SAMPLE_CITIES[2] });
    expect(next.q_income_base?.[OFFER_A.offer_id]?.annual_bonus_value).toBeDefined();
    expect(next.q3_actual_work).toBeUndefined();
    expect(filled).toBe(18);
  });

  it("不覆盖已有本地草稿，只补空字段", () => {
    const current: NodeDraft = {
      q_income_base: {
        [OFFER_A.offer_id]: { monthly_base: { status: "known", value: 21000 } },
      },
    };
    const { next } = buildSampleDrafts(QUESTIONS, [OFFER_A], current);

    const fields = next.q_income_base?.[OFFER_A.offer_id] ?? {};
    expect(fields.monthly_base).toEqual({ status: "known", value: 21000 });
    expect(next.q_basic_profile?.[OFFER_A.offer_id]?.city).toEqual({ status: "known", value: SAMPLE_CITIES[0] });
    expect(fields.annual_bonus_value).toBeDefined();
  });

  it("不覆盖服务端已答字段", () => {
    const answered = question("q_basic_profile", [field("city", "text"), field("city_affinity")]);
    answered.offers = {
      [OFFER_A.offer_id]: { status: "answered", values: { city: "深圳" } },
    };
    const { next } = buildSampleDrafts([answered, QUESTIONS[1]], [OFFER_A], {});

    const fields = next.q_basic_profile?.[OFFER_A.offer_id] ?? {};
    expect(fields.city).toBeUndefined();
    expect(fields.city_affinity).toEqual({ status: "known", value: 5 });
    expect(next.q_income_base?.[OFFER_A.offer_id]?.monthly_base).toEqual({ status: "known", value: 9500 });
  });

  it("传入空 Offer 列表时不产生任何草稿", () => {
    const { next, filled } = buildSampleDrafts(QUESTIONS, [], {});
    expect(next).toEqual({});
    expect(filled).toBe(0);
  });
});
