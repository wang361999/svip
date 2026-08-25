/** @type {import('next').NextConfig} */

// 构建时间戳 — 每次部署自动变化，用于前端缓存失效
const BUILD_VERSION = Date.now().toString();

const nextConfig = {
  images: {
    unoptimized: true,
  },
  // 隐藏 X-Powered-By 头（减少指纹信息）
  poweredByHeader: false,
  // 将构建版本号注入前端环境变量
  env: {
    NEXT_PUBLIC_BUILD_VERSION: BUILD_VERSION,
  },
  // 全局响应头 — 缓存策略 + 安全头
  async headers() {
    return [
      {
        // HTML 页面与 API：不缓存，每次都获取最新版本
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
      {
        // 所有路由：基础安全头（防点击劫持 / MIME 嗅探 / 跨站引用泄露）
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
