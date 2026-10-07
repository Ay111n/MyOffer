#!/usr/bin/env node
/**
 * e2e-prod 专用：静态导出产物 + API 反代的本地服务器。
 *
 * 模拟生产 nginx 的行为（deploy/nginx-myoffer-static.conf）：
 *   - out/ 静态文件；路由回退 try_files $uri $uri.html $uri/index.html /index.html
 *     （未知路径回 200 首页）；/_next/、/assets/ 资源缺失按 404；
 *   - /api/* 与 /healthz 反代到本地后端。
 *
 * 为什么不用 next start：生产是 output:'export'，next start 不服务 out/，
 * 也无法复现静态导出在路由回退上的行为差异（审查 F13：e2e 曾只跑 dev 形态）。
 * 仅监听 127.0.0.1，无压缩/缓存头（e2e 不需要）。
 */
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 4173);
const API_ORIGIN = process.env.API_ORIGIN || "http://127.0.0.1:8000";
const OUT_DIR = fileURLToPath(new URL("../out/", import.meta.url));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function proxy(req, res) {
  const upstream = new URL(API_ORIGIN);
  const upstreamReq = httpRequest(
    {
      host: upstream.hostname,
      port: upstream.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${upstream.hostname}:${upstream.port || 80}` },
    },
    (up) => {
      if (res.destroyed || res.writableEnded) { up.destroy(); return; }
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstreamReq.on("error", () => {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { code: "bad_gateway", message: "backend unreachable", details: {} },
    }));
  });
  res.once("close", () => upstreamReq.destroy());
  req.pipe(upstreamReq);
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  // 防路径遍历：归一化后必须仍在 out/ 内
  const root = OUT_DIR.endsWith(sep) ? OUT_DIR : OUT_DIR + sep;
  const candidate = normalize(join(root, urlPath));
  if (!candidate.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  // 与 nginx try_files $uri $uri.html $uri/index.html /index.html 同序
  const tries = [candidate, candidate + ".html", join(candidate, "index.html")];
  if (urlPath === "/" || urlPath.endsWith("/")) tries.push(join(root, "index.html"));
  for (const path of tries) {
    try {
      const s = await stat(path);
      if (s.isDirectory()) continue;
      res.writeHead(200, { "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream" });
      res.end(await readFile(path));
      return;
    } catch {
      // 尝试下一候选
    }
  }
  if (urlPath.startsWith("/_next/") || urlPath.startsWith("/assets/")) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[".html"] });
  res.end(await readFile(join(root, "index.html")));
}

createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (path === "/api" || path.startsWith("/api/") || path === "/healthz" || path === "/readyz") {
    proxy(req, res);
    return;
  }
  serveStatic(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e-static] http://127.0.0.1:${PORT}（/api → ${API_ORIGIN}）`);
});
