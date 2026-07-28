/**
 * Auth 领域 - 业务逻辑 Service
 * 使用 Prisma Client 类型安全查询，彻底废弃 $queryRawUnsafe
 */
import bcrypt from 'bcryptjs';
import { prisma } from '@/shared/lib/prisma';
import { signToken } from '@/shared/lib/jwt';
import { verifyCode, storeCode, getLastSent } from '@/shared/lib/verification';
import { sendVerificationEmail, sendPasswordResetEmail } from '@/shared/lib/email';
import {
  AuthError,
  BusinessError,
  ConflictError,
  NotFoundError,
  RateLimitError,
} from '@/shared/api/errors';
import type { JWTPayload } from '@/shared/lib/jwt';
import type { AuthUser } from './auth.dto';
import type {
  LoginInput,
  RegisterInput,
  SendCodeInput,
  ResetPasswordInput,
  ChangePasswordInput,
} from './auth.schema';

/** 脱敏用户（移除 password） */
function sanitize(user: {
  id: string;
  email: string;
  username: string;
  role: string;
  membership: string;
  membershipExpires: string | null;
  prefAB9: string;
  prefAutoFib: string;
  prefAB9Labels: string;
  createdAt: Date;
}): AuthUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    membership: user.membership,
    membershipExpires: user.membershipExpires,
    prefAB9: user.prefAB9,
    prefAutoFib: user.prefAutoFib,
    prefAB9Labels: user.prefAB9Labels,
    createdAt: user.createdAt,
  };
}

export const authService = {
  /** 登录 */
  async login(input: LoginInput): Promise<{ user: AuthUser; token: string; maxAge: number }> {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });
    if (!user) {
      throw new AuthError('AUTH_INVALID_CREDENTIALS', '邮箱或密码错误');
    }
    const ok = await bcrypt.compare(input.password, user.password);
    if (!ok) {
      throw new AuthError('AUTH_INVALID_CREDENTIALS', '邮箱或密码错误');
    }
    const maxAge = input.rememberMe ? 7 * 24 * 60 * 60 : 24 * 60 * 60;
    const token = signToken(
      { userId: user.id, email: user.email, role: user.role },
      input.rememberMe,
    );
    return { user: sanitize(user), token, maxAge };
  },

  /** 注册 */
  async register(input: RegisterInput): Promise<AuthUser> {
    // 验证码校验
    const valid = await verifyCode(input.email, input.verifyCode, 'register');
    if (!valid) {
      throw new BusinessError('AUTH_INVALID_CODE', '验证码无效或已过期，请重新获取');
    }
    // 唯一性检查
    const existingEmail = await prisma.user.findUnique({ where: { email: input.email } });
    if (existingEmail) {
      throw new ConflictError('AUTH_EMAIL_TAKEN', '该邮箱已被注册');
    }
    const existingName = await prisma.user.findUnique({ where: { username: input.username } });
    if (existingName) {
      throw new ConflictError('AUTH_USERNAME_TAKEN', '该用户名已被使用');
    }
    // 创建用户
    const hashed = await bcrypt.hash(input.password, 12);
    const user = await prisma.user.create({
      data: {
        email: input.email,
        username: input.username,
        password: hashed,
        role: 'user',
        membership: 'free',
      },
    });
    return sanitize(user);
  },

  /** 获取当前用户 */
  async getCurrentUser(payload: JWTPayload): Promise<AuthUser> {
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      throw new AuthError('AUTH_USER_NOT_FOUND', '用户不存在');
    }
    return sanitize(user);
  },

  /** 发送验证码 */
  async sendCode(input: SendCodeInput): Promise<{ devCode?: string }> {
    // 频率限制：60 秒
    const last = await getLastSent(input.email);
    const now = Date.now();
    if (last && now - last < 60000) {
      const remaining = Math.ceil((60000 - (now - last)) / 1000);
      throw new RateLimitError('AUTH_CODE_RATE_LIMIT', `请${remaining}秒后再试`);
    }
    const code = await storeCode(input.email, input.type);
    try {
      if (input.type === 'reset') {
        await sendPasswordResetEmail(input.email, code);
      } else {
        await sendVerificationEmail(input.email, code);
      }
      return {};
    } catch (err) {
      // 邮件服务未配置，开发模式返回验证码
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('邮件服务未配置') && process.env.NODE_ENV !== 'production') {
        return { devCode: code };
      }
      throw new BusinessError('AUTH_EMAIL_SEND_FAILED', '发送验证码失败，请重试');
    }
  },

  /** 重置密码 */
  async resetPassword(input: ResetPasswordInput): Promise<void> {
    const valid = await verifyCode(input.email, input.code, 'reset');
    if (!valid) {
      throw new BusinessError('AUTH_INVALID_CODE', '验证码无效或已过期');
    }
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      throw new NotFoundError('AUTH_EMAIL_NOT_FOUND', '该邮箱未注册');
    }
    const hashed = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });
  },

  /** 修改密码 */
  async changePassword(userId: string, input: ChangePasswordInput): Promise<void> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundError('AUTH_USER_NOT_FOUND', '用户不存在');
    }
    const ok = await bcrypt.compare(input.currentPassword, user.password);
    if (!ok) {
      throw new AuthError('AUTH_WRONG_PASSWORD', '当前密码错误');
    }
    const hashed = await bcrypt.hash(input.newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });
  },
};
