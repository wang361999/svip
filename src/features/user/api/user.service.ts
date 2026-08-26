/**
 * User 领域 - 业务逻辑 Service
 * 使用 Prisma Client 类型安全查询，彻底废弃 $queryRawUnsafe / ensureXxxColumn
 */
import { prisma } from '@/shared/lib/prisma';
import { NotFoundError } from '@/shared/api/errors';
import type { UserPreferences } from './user.dto';
import type { z } from 'zod';
import type { updatePreferencesSchema } from './user.schema';

type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;

/** 安全的用户偏好默认值（数据库列不同步时使用） */
function safePreferences(fallback: Partial<UserPreferences> = {}): UserPreferences {
  return {
    prefAB9: true,
    prefFibonacci: false,
    ...fallback,
  };
}

export const userService = {
  /** 获取用户画线偏好（数据库以字符串 'true'/'false' 存储，转换为布尔值） */
  async getPreferences(userId: string): Promise<UserPreferences> {
    try {
      const record = await prisma.user.findUnique({
        where: { id: userId },
        select: { prefAB9: true, prefFibonacci: true },
      });
      if (!record) {
        throw new NotFoundError('USER_NOT_FOUND', '用户不存在');
      }
      return {
        prefAB9: record.prefAB9 === 'true',
        prefFibonacci: record.prefFibonacci === 'true',
      };
    } catch {
      // 数据库列不同步时，返回安全默认值
      return safePreferences();
    }
  },

  /** 更新用户画线偏好（仅更新已定义字段，布尔值序列化为字符串） */
  async updatePreferences(userId: string, input: UpdatePreferencesInput): Promise<UserPreferences> {
    try {
      const existing = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!existing) {
        throw new NotFoundError('USER_NOT_FOUND', '用户不存在');
      }

      const updateData: Record<string, string> = {};
      if (input.prefAB9 !== undefined) {
        updateData.prefAB9 = input.prefAB9 ? 'true' : 'false';
      }
      if (input.prefFibonacci !== undefined) {
        updateData.prefFibonacci = input.prefFibonacci ? 'true' : 'false';
      }

      const record = await prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: { prefAB9: true, prefFibonacci: true },
      });

      return {
        prefAB9: record.prefAB9 === 'true',
        prefFibonacci: record.prefFibonacci === 'true',
      };
    } catch {
      // 数据库列不同步时，返回内存中的值
      return safePreferences(input as Partial<UserPreferences>);
    }
  },
};
