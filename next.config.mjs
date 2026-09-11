/** @type {import('next').NextConfig} */

// 构建时间戳 — 每次部署自动变化，用于前端缓存失效
const BUILD_VERSION = Date.now().toString();

const nextConfig = {
  images: {
    unoptimized: true,
  },
  // 隐藏 X-Powered-By 头（减少指纹信息）
  poweredByHeader: false,
  // 启用 SWC 压缩（比 Babel 快，构建更快）
  swcMinify: true,
  // 实验性优化：按需导入常用库，减小初始包体积
  experimental: {
    optimizePackageImports: ['lightweight-charts', 'zustand', 'zod'],
  },
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
          // 强制 HTTPS（2 年，含子域名，预加载）
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // 内容安全策略：
          // - Next.js 生产运行时含少量内联引导脚本，script/style 暂需 unsafe-inline（无 nonce 方案下的常见折中）
          // - 禁止 object/embed，限制 frame 祖先与 base 跳转，XSS 主要危害面仍被收敛
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' https: wss:",
              "object-src 'none'",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              'upgrade-insecure-requests',
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
