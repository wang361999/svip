/**
 * Settings 领域 - 响应 DTO 类型
 * 将 Prisma SiteSetting 模型映射为前端期望的扁平对象：
 * 所有字段均为 string（SMTP 等可空字段统一收窄为非空 string）。
 */
import type { SiteSetting } from '@prisma/client';

/** 站点设置 - 扁平对象，所有字段均为 string */
export type SiteSettings = Omit<
  SiteSetting,
  'updatedAt' | 'smtpHost' | 'smtpPort' | 'smtpSecure' | 'smtpUser' | 'smtpPass' | 'smtpFrom'
> & {
  smtpHost: string;
  smtpPort: string;
  smtpSecure: string;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
};
