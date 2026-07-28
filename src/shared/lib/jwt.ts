import jwt from 'jsonwebtoken';
import { cookies } from 'next/headers';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
}

export function signToken(payload: JWTPayload, rememberMe: boolean = false): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: rememberMe ? '7d' : '24h',
  });
}

export function verifyToken(token: string): JWTPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JWTPayload;
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