import createClient from 'openapi-fetch'; import type {paths} from './schema';
import { useFlowStore } from '@/stores/flow-store';
export const api=createClient<paths>({baseUrl:'',credentials:'include'});

/** 会话失效提示标记：discardLocalSession 写入，填写页读到后 toast 一次性
 *  清除——把「静默弹回首页」变成有交代（2026-10-28 反馈）。 */
export const SESSION_EXPIRED_FLAG = "myoffer_session_expired";

/** 解除当前页面里的失效会话绑定；非首页整页跳转到新的填写流程。
 *  只解除绑定，不删本机草稿：服务端丢状态（重启/替换/清理）不应连用户
 *  在浏览器里的内容陪葬。旧草稿由填写页的「恢复上次填写」横幅接管
 *  （listOrphanDraftSessions），24h TTL 到期自然淘汰。 */
function discardLocalSession(): void {
  // 清理旧版本留下的 localStorage，当前版本不再读它。
  // 存储访问本身可能抛异常（严格隐私设置禁用存储）——其余存储触点都有
  // try/catch 兜底，这里漏了会让 401/404 的优雅回退变成不透明报错。
  try {
    localStorage.removeItem("offer-flow");
  } catch {
    // 存储不可用：清状态照常进行（内存态仍会重置）
  }
  try {
    sessionStorage.setItem(SESSION_EXPIRED_FLAG, "1");
  } catch {
    // 存储不可用：提示缺席，不影响回退本身
  }
  useFlowStore.getState().enterSession(null);
  // 身份失效时整页重载，同时销毁 React Query 缓存和模块内状态，避免沿用旧身份数据。
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 此处需要完整页面重载来隔离身份状态。
  if (window.location.pathname !== "/") window.location.assign("/");
}

function sessionIdFromApiPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)/);
  return match?.[1] ?? null;
}

/** 统一处理本地会话失效，避免各页面停留在只会报错的死页面：
 *  - 401：匿名 cookie 过期/无效，所有接口都不可用；
 *  - 404 且 message 为 "Session not found"：当前页面里的临时工作区
 *    在后端已不存在或不属于当前匿名身份（服务重启/工作区被清理）。
 *    只认 require_owned_session（backend/app/api/deps.py）的这条固定文案，
 *    普通资源 404（如 Offer not found）不清本地状态。 */
api.use({
  async onResponse({ response }) {
    if (typeof window === "undefined") return undefined;
    if (response.status === 401) {
      const requestSessionId = sessionIdFromApiPath(new URL(response.url).pathname);
      if (requestSessionId && requestSessionId !== useFlowStore.getState().sessionId) return undefined;
      // 只认后端统一的 unauthenticated 包络：未来新增的受限 401 路由
      // （如未激活/受限资源）不应误清本地会话状态
      try {
        const body: unknown = await response.clone().json();
        const envelope = (body as {error?: {code?: unknown}} | null)?.error;
        if (envelope?.code !== "unauthenticated") return undefined;
      } catch {
        // 响应体不可解析（代理 HTML 等）→ 按非会话类 401 处理，不清状态
        return undefined;
      }
      discardLocalSession();
      return undefined;
    }
    if (response.status === 404 && new URL(response.url).pathname.startsWith("/api/v1/sessions/")) {
      // 刷新后旧会话的并发请求可能晚于新会话返回 404；只处理仍对应当前
      // sessionId 的响应，避免把新的临时填写流程误判成失效。
      const requestSessionId = sessionIdFromApiPath(new URL(response.url).pathname);
      if (requestSessionId !== useFlowStore.getState().sessionId) return undefined;
      try {
        // 中间件之后 openapi-fetch 才解析响应体，这里必须用 clone() 读取。
        const body: unknown = await response.clone().json();
        const envelope = (body as {error?: {code?: unknown; message?: unknown}} | null)?.error;
        if (envelope?.code === "not_found" && envelope?.message === "Session not found") {
          discardLocalSession();
        }
      } catch {
        // 404 响应体不是约定的错误包络（如代理返回的 HTML）→ 交给页面正常展示
      }
    }
    return undefined;
  },
});
