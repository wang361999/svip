/**
 * Settings 领域 - 业务逻辑 Service
 * 使用 Prisma Client 类型安全查询，彻底废弃 ensureColumns / $queryRawUnsafe / SQL 字符串拼接。
 */
import { prisma } from '@/shared/lib/prisma';
import type { SiteSetting } from '@prisma/client';
import type { UpdateSettingsInput } from './settings.schema';

/** 安全获取设置，数据库列不同步时返回带默认值的对象 */
function safeSettings(fallback: Partial<SiteSetting> = {}): SiteSetting {
  return {
    id: 'main',
    siteTitle: 'ETH Trading Tool',
    siteSubtitle: 'Real-time Ethereum Trading Platform',
    siteLogo: '/logo.svg',
    footerText: '© 2024 ETH Trading Tool. All rights reserved.',
    primaryColor: '#3b82f6',
    indicatorEMA: 'false',
    indicatorBOLL: 'true',
    indicatorMACD: 'true',
    indicatorRSI: 'false',
    indicatorATR: 'false',
    emaPeriod: '20',
    bollPeriod: '20',
    rsiPeriod: '14',
    atrPeriod: '14',
    macdFast: '12',
    macdSlow: '26',
    macdSignal: '9',
    showPriceCard: 'true',
    enableRegistration: 'true',
    smtpHost: '',
    smtpPort: '465',
    smtpSecure: 'true',
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    ab9Line1Color: 'rgba(100, 116, 139, 0.3)',
    ab9Line2Color: 'rgba(100, 116, 139, 0.35)',
    ab9Line3Color: 'rgba(239, 68, 68, 0.75)',
    ab9Line4Color: 'rgba(148, 163, 184, 0.7)',
    ab9Line5Color: 'rgba(34, 197, 94, 0.75)',
    ab9Line6Color: 'rgba(100, 116, 139, 0.45)',
    ab9Line7Color: 'rgba(100, 116, 139, 0.45)',
    ab9Line8Color: 'rgba(148, 163, 184, 0.6)',
    ab9Line9Color: 'rgba(168, 85, 247, 0.6)',
    updatedAt: new Date(),
    ...fallback,
  };
}

export const settingsService = {
  /**
   * 获取站点设置。
   * 若主记录不存在，则使用 Prisma 默认值创建一条 id='main' 的记录后返回。
   * 数据库列不同步时返回安全默认值。
   */
  async getSettings(): Promise<SiteSetting> {
    try {
      const existing = await prisma.siteSetting.findUnique({
        where: { id: 'main' },
      });
      if (existing) {
        return existing;
      }
      return prisma.siteSetting.create({
        data: { id: 'main' },
      });
    } catch {
      // 数据库列不同步时返回安全默认值
      return safeSettings() as SiteSetting;
    }
  },

  /**
   * 更新站点设置。
   * 使用 upsert：记录存在则更新传入字段，不存在则以默认值 + 传入字段创建。
   */
  async updateSettings(input: UpdateSettingsInput): Promise<SiteSetting> {
    try {
      return prisma.siteSetting.upsert({
        where: { id: 'main' },
        update: { ...input },
        create: { id: 'main', ...input },
      });
    } catch {
      // 数据库列不同步时，只返回内存中的值
      return safeSettings(input) as SiteSetting;
    }
  },
};
