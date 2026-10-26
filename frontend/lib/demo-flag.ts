/** 示例报告直达的会话内标记（sessionStorage）。
 *
 *  「先看一份示例报告」写入；结果页读取后展示示例横幅并提供一键清回空白；
 *  用户自行生成真实报告时清除。 */
export const DEMO_FLAG_KEY = "myoffer_demo";

export function markDemoSession(): void {
  try {
    sessionStorage.setItem(DEMO_FLAG_KEY, "1");
  } catch {
    // 存储不可用：只影响横幅展示，不影响生成流程
  }
}

export function readDemoFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(DEMO_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function clearDemoFlag(): void {
  try {
    sessionStorage.removeItem(DEMO_FLAG_KEY);
  } catch {
    // 忽略
  }
}
