import CompletePage from "./complete/page";

/**
 * 信息填写页就是产品首页。
 *
 * 保留 `/complete` 路由作为兼容入口，避免旧书签或已有链接失效；
 * 新用户访问根路径时直接进入同一份信息填写流程。
 */
export default function Home() {
  return <CompletePage />;
}
