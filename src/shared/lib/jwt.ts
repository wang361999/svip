import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';

const JWT_SECRET = process.env.JWT_SECRET || '';

// 安全加固：生产环境必须显式配置 JWT_SECRET，禁止回落到弱默认值
// （弱默认值一旦泄露 = 任何人可伪造管理员 token）
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error(
    '[启动失败] 生产环境缺少 JWT_SECRET 环境变量。请在 Vercel Dashboard → Settings → Environment Variables 添加一个强随机密钥后重新部署。',
  );
}
const EFFECTIVE_SECRET = JWT_SECRET || 'dev-only-secret';

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
}

export function signToken(payload: JWTPayload, rememberMe: boolean = false): string {
  return jwt.sign(payload, EFFECTIVE_SECRET, {
    expiresIn: rememberMe ? '7d' : '24h',
  });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, EFFECTIVE_SECRET) as JWTPayload;
  } catch {
    return null;
  }
}

export function getTokenFromCookies(): string | undefined {
  const cookieStore = cookies();
  return cookieStore.get('token')?.value;
}

export function getCurrentUser(): JWTPayload | null {
  const token = getTokenFromCookies();
  if (!token) return null;
  return verifyToken(token);
}