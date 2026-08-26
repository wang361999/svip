/**
 * RedeemCode 领域 - 业务逻辑 Service
 * 使用 Prisma Client 类型安全查询，彻底废弃 $queryRawUnsafe / ensureXxxTable / esc()
 */
import { prisma } from '@/shared/lib/prisma';
import { BusinessError, NotFoundError } from '@/shared/api/errors';
import type { RedeemCodeItem } from './redeem-codes.dto';

/** 生成随机兑换码（格式：XXXX-XXXX-XXXX） */
function generateCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${segment()}-${segment()}-${segment()}`;
}

export const redeemCodeService = {
  /** 列出全部兑换码（按创建时间倒序） */
  async list(): Promise<RedeemCodeItem[]> {
    return prisma.redeemCode.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        code: true,
        days: true,
        used: true,
        usedBy: true,
        usedAt: true,
        createdAt: true,
      },
    });
  },

  /** 批量生成兑换码，返回生成的兑换码字符串数组 */
  async generate(count: number, days: number): Promise<string[]> {
    const generated: string[] = [];
    for (let i = 0; i < count; i++) {
      let code: string;
      let exists = true;
      let attempts = 0;
      // 防止重复码，最多重试 10 次
      while (exists && attempts < 10) {
        code = generateCode();
        const found = await prisma.redeemCode.findUnique({ where: { code } });
        if (!found) {
          await prisma.redeemCode.create({
            data: { code, days },
          });
          generated.push(code);
          exists = false;
        }
        attempts++;
      }
    }
    return generated;
  },

  /** 用户激活兑换码，开通/续期 VIP */
  async activate(
    userId: string,
    code: string,
  ): Promise<{ message: string; expiresAt: string }> {
    // 1. 查找兑换码
    const redeemCode = await prisma.redeemCode.findUnique({ where: { code } });
    if (!redeemCode) {
      throw new BusinessError('REDEEM_CODE_NOT_FOUND', '兑换码不存在');
    }

    // 2. 检查是否已使用
    if (redeemCode.used) {
      throw new BusinessError('REDEEM_CODE_USED', '该兑换码已被使用');
    }

    // 3. 查找用户
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { membership: true, membershipExpires: true },
    });
    if (!user) {
      throw new NotFoundError('USER_NOT_FOUND', '用户不存在');
    }

    // 4. 计算新的会员到期时间
    // 当前是 VIP 且未过期，则在原到期时间上叠加；否则从当前时间开始
    const now = Date.now();
    const ms = redeemCode.days * 24 * 60 * 60 * 1000;
    let newExpiry: Date;
    if (
      user.membership === 'vip' &&
      user.membershipExpires &&
      new Date(user.membershipExpires).getTime() > now
    ) {
      newExpiry = new Date(new Date(user.membershipExpires).getTime() + ms);
    } else {
      newExpiry = new Date(now + ms);
    }
    const expiresAt = newExpiry.toISOString();

    // 5. 事务：标记兑换码已使用 + 更新用户 VIP 信息
    try {
      await prisma.$transaction([
        prisma.redeemCode.update({
          where: { id: redeemCode.id },
          data: {
            used: true,
            usedBy: userId,
            usedAt: new Date(),
          },
        }),
        prisma.user.update({
          where: { id: userId },
          data: {
            membership: 'vip',
            membershipExpires: expiresAt,
            prefAB9: 'true',
            prefFibonacci: 'true',
          },
        }),
      ]);
    } catch {
      // 数据库列不同步时，只更新会员信息，跳过画线偏好
      await prisma.$transaction([
        prisma.redeemCode.update({
          where: { id: redeemCode.id },
          data: {
            used: true,
            usedBy: userId,
            usedAt: new Date(),
          },
        }),
        prisma.user.update({
          where: { id: userId },
          data: {
            membership: 'vip',
            membershipExpires: expiresAt,
          },
        }),
      ]);
    }

    // 6. 返回结果
    return {
      message: `兑换成功！VIP会员已开通 ${redeemCode.days} 天`,
      expiresAt,
    };
  },
};
