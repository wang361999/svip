/** @type {import('next').NextConfig} */

// 构建时间戳 — 每次部署自动变化，用于前端缓存失效
const BUILD_VERSION = Date.now().toString();

const nextConfig = {
  images: {
    unoptimized: true,
  },
  // 将构建版本号注入前端环境变量
  env: {
    NEXT_PUBLIC_BUILD_VERSION: BUILD_VERSION,
  },
  // 全局响应头 — 防止部署后浏览器使用旧缓存
  async headers() {
    return [
      {
        // HTML 页面：不缓存，每次都获取最新版本
        source: '/((?!_next/static/|_next/image/|favicon\\.ico|logo\\.svg).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'Expires', value: '0' },
        ],
      },
      {
        // 带 hash 的静态资源（JS/CSS）：永久缓存（文件名变了自动失效）
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default nextConfig;
