import { twMerge } from "tailwind-merge";

export function cn(...parts: (string | false | null | undefined)[]) {
  return twMerge(parts.filter((part): part is string => Boolean(part)).join(" "));
}

/** 城市输入规范化：去空白、去尾部「市」（与后端约束匹配口径一致）。 */
export function normalizeCity(raw: string): string {
  return raw.trim().replace(/\s+/g, "").replace(/市+$/, "");
}

/**
 * 列表中不属于支持城市 universe 的取值（历史遗留参数、非法输入）。
 * supported 为空（选项尚未加载）时视为全部支持，避免加载竞态误报——
 * 后端写入白名单是最终防线。
 */
export function unsupportedCities(
  cities: string[],
  supported: readonly string[] | undefined,
): string[] {
  if (!supported || supported.length === 0) return [];
  const set = new Set(supported);
  return cities.filter((c) => !set.has(c));
}

/** 按 offer_id 取公司名；找不到时用给定的兜底文案。 */
export function companyOf(
  offers: { offer_id: string; company: string }[] | undefined,
  oid: string | null | undefined,
  fallback = "Offer",
): string {
  return offers?.find((o) => o.offer_id === oid)?.company ?? fallback;
}
