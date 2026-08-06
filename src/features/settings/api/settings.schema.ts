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
  indicatorMA: z.string().optional(),
  indicatorEMA: z.string().optional(),
  indicatorBOLL: z.string().optional(),
  indicatorMACD: z.string().optional(),
  indicatorRSI: z.string().optional(),
  indicatorATR: z.string().optional(),
  indicatorFIB: z.string().optional(),
  indicatorTDSequential: z.string().optional(),
  indicatorNAKED: z.string().optional(),
  // 指标周期参数
  maPeriod: z.string().optional(),
  emaPeriod: z.string().optional(),
  bollPeriod: z.string().optional(),
  rsiPeriod: z.string().optional(),
  atrPeriod: z.string().optional(),
  macdFast: z.string().optional(),
  macdSlow: z.string().optional(),
  macdSignal: z.string().optional(),
  // 显示控制
  showPriceCard: z.string().optional(),
  showFibPanel: z.string().optional(),
  showMarketStructure: z.string().optional(),
  showEntrySignal: z.string().optional(),
  showExitSignal: z.string().optional(),
  showGannAngle: z.string().optional(),
  showNakedBullBear: z.string().optional(),
  showFibDraw: z.string().optional(),
  fibLabeled: z.string().optional(),
  fibUnlabeled: z.string().optional(),
  enableRegistration: z.string().optional(),
  // SMTP 邮箱配置（允许空字符串）
  smtpHost: z.string().optional(),
  smtpPort: z.string().optional(),
  smtpSecure: z.string().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
  // AB9 九线颜色配置
  ab9Line1Color: z.string().optional(),
  ab9Line2Color: z.string().optional(),
  ab9Line3Color: z.string().optional(),
  ab9Line4Color: z.string().optional(),
  ab9Line5Color: z.string().optional(),
  ab9Line6Color: z.string().optional(),
  ab9Line7Color: z.string().optional(),
  ab9Line8Color: z.string().optional(),
  ab9Line9Color: z.string().optional(),
  paperTradingEnabled: z.string().optional(),
  // Cron 引擎配置
  cronLoops: z.string().optional(),
  cronInterval: z.string().optional(),
  cronLogTtl: z.string().optional(),
  // AI 模型配置
  aiEnabled: z.string().optional(),
  aiProvider: z.string().optional(),
  aiApiUrl: z.string().optional(),
  aiApiKey: z.string().optional(),
  aiModel: z.string().optional(),
  aiTemperature: z.string().optional(),
  aiMaxTokens: z.string().optional(),
  aiAnalysisInterval: z.string().optional(),
  aiAutoTrade: z.string().optional(),
});

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
