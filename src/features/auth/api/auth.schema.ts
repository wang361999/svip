/**
 * Auth 领域 - zod schemas
 */
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  password: z.string().min(1, '请输入密码'),
  rememberMe: z.boolean().optional().default(false),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  username: z.string().min(1, '请输入用户名').max(30, '用户名最长30个字符'),
  password: z.string().min(6, '密码长度至少6位'),
  verifyCode: z.string().min(1, '请输入验证码'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const sendCodeSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  type: z.enum(['register', 'reset']).default('register'),
});
export type SendCodeInput = z.infer<typeof sendCodeSchema>;

export const resetPasswordSchema = z.object({
  email: z.string().email('邮箱格式不正确'),
  code: z.string().min(1, '请输入验证码'),
  newPassword: z.string().min(6, '密码长度至少6位'),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(6, '新密码长度至少6位'),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
