import { cn } from "@/lib/utils";

/** MyOffer 标记：两根高度不同的竖条 + 一个落点，表达「并排比较 → 选定一个」。
 *  纯 SVG，随 className 缩放，颜色取品牌色。 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex shrink-0 items-center justify-center rounded-[26%] bg-blue-700 text-white", className)}
    >
      <svg viewBox="0 0 24 24" className="h-[62%] w-[62%]" fill="none">
        <rect x="4.5" y="9" width="4" height="10" rx="1.2" fill="currentColor" opacity="0.55" />
        <rect x="10" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
        <circle cx="18.5" cy="7" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

/** 顶栏字标：BrandMark + MyOffer 文字（实时文本渲染，保证各分辨率下清晰）。
 *  手机宽度（<sm）只留标记：四个顶栏操作项的横向预算有限，字标是唯一
 *  可牺牲项——缺它曾把「模型配置 / 清除本机数据」压成逐字竖排
 *  （2026-10-28 反馈）。 */
export function BrandLogo() {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark className="h-7 w-7" />
      <span className="hidden text-[17px] font-bold leading-none tracking-[-0.02em] text-ink sm:inline">MyOffer</span>
    </span>
  );
}
