import type { NextConfig } from 'next';

const backend = process.env.BACKEND_ORIGIN ?? 'http://localhost:8000';

// 生产构建输出静态文件交给 nginx 托管；开发环境通过 rewrite 访问本地后端。
const isExport = process.env.NODE_ENV === 'production';

const config: NextConfig = isExport
  ? {
      output: 'export',
      // 静态导出没有 Node 侧的图片优化服务；本项目只用 2 个 PNG logo，
      // 未使用 next/image，保留该开关只为将来直接换 next/image 时不炸。
      images: { unoptimized: true },
    }
  : {
      // Next dev binds to `localhost`, while this project is also commonly
      // opened as 127.0.0.1:3000. Allow that loopback origin so client chunks
      // and hydration resources are available at the documented URL.
      allowedDevOrigins: ["127.0.0.1"],
      async rewrites() {
        return [{ source: '/api/:path*', destination: `${backend}/api/:path*` }];
      },
    };

export default config;
