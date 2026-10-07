import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <p className="text-[14px] font-semibold uppercase tracking-[0.24em] text-neutral-500">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-[-0.01em] text-neutral-950">页面不存在</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-500">
        你要找的页面不在这里。回到首页继续你的 Offer 比较。
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center rounded-full bg-neutral-950 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700"
      >
        返回首页
      </Link>
    </div>
  );
}
