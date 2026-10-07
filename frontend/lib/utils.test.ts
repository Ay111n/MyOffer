import { describe, expect, it } from "vitest";

import { companyOf, normalizeCity, unsupportedCities } from "./utils";

describe("normalizeCity（与后端约束匹配口径一致）", () => {
  it("去空白与尾部「市」", () => {
    expect(normalizeCity(" 北京 ")).toBe("北京");
    expect(normalizeCity("上海市")).toBe("上海");
    expect(normalizeCity("北京市市")).toBe("北京");
  });
});

describe("unsupportedCities（城市 universe 一致性）", () => {
  const SUPPORTED = ["北京", "上海", "广州", "深圳"] as const;

  it("筛出不属于支持列表的取值，保持顺序", () => {
    expect(unsupportedCities(["北京", "成都", "杭州"], SUPPORTED)).toEqual(["成都", "杭州"]);
    expect(unsupportedCities(["上海"], SUPPORTED)).toEqual([]);
  });

  it("支持列表未加载（undefined/空）时不误报，后端写入白名单是最终防线", () => {
    expect(unsupportedCities(["成都"], undefined)).toEqual([]);
    expect(unsupportedCities(["成都"], [])).toEqual([]);
  });
});

describe("companyOf", () => {
  const offers = [
    { offer_id: "a", company: "A公司" },
    { offer_id: "b", company: "B公司" },
  ];

  it("按 id 取公司名，支持自定义兜底文案", () => {
    expect(companyOf(offers, "a")).toBe("A公司");
    expect(companyOf(offers, "zzz")).toBe("Offer");
    expect(companyOf(offers, "zzz", "另一个 Offer")).toBe("另一个 Offer");
    expect(companyOf(undefined, "a")).toBe("Offer");
  });
});
