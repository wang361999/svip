/**
 * Auth 领域 - 响应 DTO 类型
 */
import type { User } from '@prisma/client';

/** 登录/注册成功后返回的用户信息（脱敏，不含 password） */
export type AuthUser = Pick<
  User,
  'id' | 'email' | 'username' | 'role' | 'membership' | 'membershipExpires' | 'createdAt'
> & {
  prefAB9?: string;
  prefAutoFib?: string;
  prefAB9Labels?: string;
};

/** 登录响应 */
export interface LoginResult {
  user: AuthUser;
}
