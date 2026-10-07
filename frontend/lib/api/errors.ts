/** Convert the API's error envelope (or a network/client error) into a
 * user-facing message without making every page know the transport shape. */
export function readApiError(
  error: unknown,
  fallback = "请求失败，请检查网络后重试。",
): string {
  const present = (message: string): string =>
    /result not found|no snapshot yet/i.test(message) ? fallback : message;

  if (error && typeof error === "object") {
    const candidate = error as {
      error?: {
        message?: unknown;
        details?: { field_errors?: { message?: unknown }[] };
      };
      detail?: {
        message?: unknown;
        details?: { field_errors?: { message?: unknown }[] };
      };
      message?: unknown;
    };
    const envelope = candidate.error ?? candidate.detail;
    const fieldErrors = envelope?.details?.field_errors
      ?.map((item) => (typeof item.message === "string" ? item.message : ""))
      .filter(Boolean);
    if (fieldErrors && fieldErrors.length > 0) return fieldErrors.join("；");
    if (typeof envelope?.message === "string" && envelope.message) {
      return present(envelope.message);
    }
    if (typeof candidate.message === "string" && candidate.message) {
      return present(candidate.message);
    }
  }
  if (error instanceof Error && error.message) return present(error.message);
  return fallback;
}

/** 后端 401 的统一错误包络（backend/app/api/deps.py::_unauthenticated）。
 *
 * 匿名会话是"首次写入时才建立"的：新访客的浏览器还没有 offer_sid Cookie，
 * 此时任何需要会话的接口都会返回 401 unauthenticated —— 这是**正常状态**，
 * 不是失败。调用方据此区分"还没有会话"与"请求真的出错了"。 */
export function isUnauthenticatedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    error?: { code?: unknown };
    detail?: { code?: unknown };
  };
  const envelope = candidate.error ?? candidate.detail;
  return envelope?.code === "unauthenticated";
}
