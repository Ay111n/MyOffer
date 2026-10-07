import { expect, test } from "@playwright/test";

for (const [name, size] of [["桌面", { width: 1440, height: 900 }], ["手机", { width: 390, height: 844 }]] as const) {
  for (const deleted of ["A", "B", "C"]) {
    test(`${name}端删除 Offer ${deleted} 后编号连续且新增仍为 C`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto("/");
      const tabs = page.getByRole("group", { name: "Offer 切换" });
      const labels = tabs.locator('button[aria-controls="offer-panel"]');
      await expect(labels).toHaveCount(2);
      await tabs.getByRole("button", { name: "添加 Offer", exact: true }).click();
      await expect(labels).toHaveCount(3);
      await tabs.getByRole("button", { name: `删除 Offer ${deleted}`, exact: true }).click();
      await expect(labels).toHaveCount(2);
      await expect(labels.nth(0)).toContainText("Offer A");
      await expect(labels.nth(1)).toContainText("Offer B");
      await page.reload();
      await expect(labels.nth(0)).toContainText("Offer A");
      await expect(labels.nth(1)).toContainText("Offer B");
      await tabs.getByRole("button", { name: "添加 Offer", exact: true }).click();
      await expect(labels).toHaveCount(3);
      await expect(labels.nth(2)).toContainText("Offer C");
    });
  }
}
