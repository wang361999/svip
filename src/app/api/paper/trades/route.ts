/**
 * 模拟盘历史交易记录 API
 * GET /api/paper/trades?limit=50  - 获取历史交易
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { getTrades } from '@/shared/lib/paper-trading';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async ({ req }) => {
  const user = requireUser();
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const trades = await getTrades(user.userId, limit);
  return apiSuccess(trades);
});
