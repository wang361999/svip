import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 需要管理员权限的路径
const ADMIN_PATHS = ['/admin', '/api/admin'];
// 需要登录的路径
const AUTH_REQUIRED_PATHS = ['/api/user'];

/** 给响应添加防缓存头 */
function withNoCacheHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('token')?.value;

  // 管理员路由保护
  const isAdminPath = ADMIN_PATHS.some(p => pathname.startsWith(p));
  if (isAdminPath) {
    if (!token) {
      if (pathname.startsWith('/api/')) {
        return withNoCacheHeaders(
          NextResponse.json({ error: '请先登录' }, { status: 401 }),
        );
      }
      return withNoCacheHeaders(NextResponse.redirect(new URL('/login', request.url)));
    }
    // 管理员权限验证在 API 路由和页面组件中进一步检查
  }

  // 需要登录的 API 路由保护
  const isAuthRequired = AUTH_REQUIRED_PATHS.some(p => pathname.startsWith(p));
  if (isAuthRequired && !token) {
    return withNoCacheHeaders(
      NextResponse.json({ error: '请先登录' }, { status: 401 }),
    );
  }

  // 所有经过 middleware 的响应都添加防缓存头
  return withNoCacheHeaders(NextResponse.next());
}

export const config = {
  matcher: [
    '/admin/:path*',
    '/api/admin/:path*',
    '/api/user/:path*',
    '/api/paper/:path*',
    '/api/trades/:path*',
    '/api/settings/:path*',
  ],
};
