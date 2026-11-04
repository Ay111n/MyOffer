import type { Page } from "@playwright/test";

import { EXAMPLE_DETAILS, EXAMPLE_OFFERS } from "../lib/example-offers";

/**
 * 用 API 把示例画像写进当前会话的全部 Offer。
 *
 * 「用示例数据填空白项」入口已按产品决策移除（与「先看一份示例报告」
 * 功能重叠）；e2e 需要造数时走同一条服务端写入口径（PATCH facts），
 * 与用户手填的落库路径一致。
 */
export async function fillExampleFactsViaApi(page: Page): Promise<void> {
  const sid = await page.evaluate(() => sessionStorage.getItem("myoffer_sid"));
  if (!sid) throw new Error("no active session to fill");
  const offers = (await (await page.request.get(`/api/v1/sessions/${sid}/offers`)).json()).data as Array<{
    offer_id: string; version: number; display_order: number;
  }>;
  for (const offer of offers) {
    const profile = { ...EXAMPLE_OFFERS[offer.display_order - 1], ...EXAMPLE_DETAILS[offer.display_order - 1] };
    const patched = await page.request.patch(`/api/v1/sessions/${sid}/offers/${offer.offer_id}`, { data: {
      version: offer.version,
      facts: Object.entries(profile).map(([field_key, value]) => ({ field_key, value })),
    } });
    if (!patched.ok()) throw new Error(`facts patch failed for ${offer.display_order}: ${patched.status()}`);
  }
  // 页面外的 API 写入不会失效页面的 React Query 缓存：重载让表单读到服务端事实
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}
