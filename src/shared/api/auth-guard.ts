/**
 * 服务端鉴权守卫
 * - requireUser(): 需登录，返回当前用户 JWT payload
 * - requireAdmin(): 需管理员
 * - getOptionalUser(): 返回当前用户（可空）
 */
import { getTokenFromCookies, verifyToken, type JWTPayload } from '@/shared/lib/jwt';
import { AuthError, ForbiddenError } from './errors';

/** 获取当前用户（未登录返回 null） */
export function getOptionalUser(): JWTPayload | null {
  const token = getTokenFromCookies();
  if (!token) return null;
  return verifyToken(token);
}

/** 要求已登录，未登录抛 AuthError(401) */
export function requireUser(): JWTPayload {
  const user = getOptionalUser();
  if (!user) {
    throw new AuthError('AUTH_UNAUTHORIZED', '请先登录');
  }
  return user;
}

/** 要求管理员，未登录抛 401，非管理员抛 403 */
export function requireAdmin(): JWTPayload {
  const user = requireUser();
  if (user.role !== 'admin') {
    throw new ForbiddenError('AUTH_NOT_ADMIN', '需要管理员权限');
  }
  return user;
}
