import { z } from 'zod';

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateMembershipSchema = z.object({
  userId: z.string().min(1, '缺少用户ID'),
  membership: z.enum(['free', 'vip'], { message: '无效的会员类型' }),
});
