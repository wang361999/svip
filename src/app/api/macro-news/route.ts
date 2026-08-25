/**
 * 消息面 API
 *
 * GET /api/macro-news — 美联储利率状态 + FOMC 倒计时 + 宏观/加密新闻流
 * 服务端 10 分钟缓存（Vercel CPU 优化），requireUser 保护
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { fetchMacroNews, buildDailyDigest } from '@/shared/lib/macro-news';

export const dynamic = 'force-dynamic';

export const GET = createHandler(async () => {
  requireUser();
  const data = await fetchMacroNews();
  return apiSuccess({ ...data, digest: buildDailyDigest(data) });
});
