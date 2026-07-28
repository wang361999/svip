/**
 * Users 领域 - 业务逻辑 Service
 * 使用 Prisma Client 类型安全查询，彻底废弃 $queryRawUnsafe / ensureXxxColumn
 */
import { prisma } from '@/shared/lib/prisma';
import { NotFoundError } from '@/shared/api/errors';
import type { UserListItem } from './users.dto';

export const usersService = {
  /** 分页查询用户列表（仅安全字段，不含 password） */
  async list(query: { page: number; limit: number }): Promise<{
    items: UserListItem[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          membership: true,
          membershipExpires: true,
          createdAt: true,
        },
      }),
      prisma.user.count(),
    ]);

    return {
      items,
      total,
      page,
      pageSize: limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  },

  /** 更新用户会员类型 */
  async updateMembership(userId: string, membership: string): Promise<{ membership: string }> {
    const existing = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!existing) {
      throw new NotFoundError('USER_NOT_FOUND', '用户不存在');
    }
    const user = await prisma.user.update({
      where: { id: userId },
      data: { membership },
      select: { membership: true },
    });
    return user;
  },
};
