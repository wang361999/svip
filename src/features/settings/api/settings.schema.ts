/**
 * Settings 领域 - zod schemas
 * 对应 Prisma SiteSetting 模型，所有字段均为 String 类型。
 * - 布尔型字段（指标开关 / show*）以字符串形式接收（"true" / "false"）
 * - SMTP 字段允许空字符串
 */
import { z } from 'zod';

export const updateSettingsSchema = z.object({
  // 基础信息
  siteTitle: z.string().optional(),
  siteSubtitle: z.string().optional(),
  siteLogo: z.string().optional(),
  footerText: z.string().optional(),
  primaryColor: z.string().optional(),
  // 指标开关
  indicatorEMA: z.string().optional(),
  indicatorBOLL: z.string().optional(),
  indicatorMACD: z.string().optional(),
  indicatorRSI: z.string().optional(),
  // 指标周期参数
  emaPeriod: z.string().optional(),
  bollPeriod: z.string().optional(),
  rsiPeriod: z.string().optional(),
  macdFast: z.string().optional(),
  macdSlow: z.string().optional(),
  macdSignal: z.string().optional(),
  // 显示控制
  showPriceCard: z.string().optional(),
  enableRegistration: z.string().optional(),
  // SMTP 邮箱配置（允许空字符串）
  smtpHost: z.string().optional(),
  smtpPort: z.string().optional(),
  smtpSecure: z.string().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
