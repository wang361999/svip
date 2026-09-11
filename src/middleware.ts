import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// 需要管理员权限的路径
const ADMIN_PATHS = ['/admin', '/api/admin'];
// 需要登录的路径
const AUTH_REQUIRED_PATHS = ['/api/user', '/api/paper', '/api/trades', '/api/settings'];

/** 给响应添加防缓存头 */
function withNoCacheHeaders(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  return response;
}

interface EdgeJWTPayload {
  userId?: string;
  role?: string;
  exp?: number;
}

/** Base64URL 解码（Edge Runtime 无 Buffer，用 atob） */
function b64urlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
  return atob(padded);
}

/**
 * Edge 运行时验签 JWT（HS256，Web Crypto 实现）
 * 不依赖 jsonwebtoken（Node 库，无法在 middleware 运行）
 * 生产环境必须配置 JWT_SECRET；开发环境回退弱密钥（与 src/shared/lib/jwt.ts 保持一致）
 */
async function verifyEdgeJwt(token: string): Promise<EdgeJWTPayload | null> {
  const secret =
    process.env.JWT_SECRET ||
    (process.env.NODE_ENV === 'production' ? '' : 'dev-only-secret');
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const signature = Uint8Array.from(b64urlDecode(parts[2]), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;

    const payload = JSON.parse(b64urlDecode(parts[1])) as EdgeJWTPayload;
    if (payload.exp && Date.now() >= payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('token')?.value;
  const payload = token ? await verifyEdgeJwt(token) : null;

  const isApi = pathname.startsWith('/api/');
  const deny = (status: number, body: string) =>
    withNoCacheHeaders(NextResponse.json({ error: body }, { status }));

  // 管理员路由保护：必须为验签通过且 role=admin
  const isAdminPath = ADMIN_PATHS.some((p) => pathname.startsWith(p));
  if (isAdminPath) {
    if (!payload) {
      return isApi ? deny(401, '请先登录') : withNoCacheHeaders(NextResponse.redirect(new URL('/login', request.url)));
    }
    if (payload.role !== 'admin') {
      return isApi ? deny(403, '需要管理员权限') : withNoCacheHeaders(NextResponse.redirect(new URL('/', request.url)));
    }
  }

  // 需要登录的 API 路由保护：必须验签通过
  const isAuthRequired = AUTH_REQUIRED_PATHS.some((p) => pathname.startsWith(p));
  if (isAuthRequired && !payload) {
    return deny(401, '请先登录');
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
