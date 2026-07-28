/**
 * 模拟盘统计数据 API
 * GET /api/paper/stats  - 获取统计数据
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { getStats } from '@/shared/lib/paper-trading';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async () => {
  const user = requireUser();
  const stats = await getStats(user.userId);
  return apiSuccess(stats);
});
