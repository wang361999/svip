/**
 * 多周期趋势分析 API
 * GET /api/market/trend?symbol=ETHUSDT&okxId=ETH-USDT
 *
 * 返回 15m / 1h / 4h / 1d 四个周期的趋势判定（多/空/震荡）
 * 带 30 秒内存缓存：面板 60 秒轮询 + 多用户访问时不重复拉取行情
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { prisma } from '@/shared/lib/prisma';
import { analyzeTrend, type TrendAnalysis } from '@/shared/lib/trend-analysis';

export const dynamic = 'force-dynamic';

/** 简单内存缓存：symbol → { data, at } */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { data: TrendAnalysis; at: number }>();

// 定期清理过期缓存，避免 Map 无限增长
const CLEANUP_INTERVAL_MS = 5 * 60_000;
let lastCleanup = Date.now();
function cleanupCache() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  cache.forEach((v, k) => {
    if (now - v.at > CACHE_TTL_MS * 4) cache.delete(k);
  });
}

export const GET = createHandler(async ({ req }) => {
  requireUser();

  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol');
  const okxId = searchParams.get('okxId');

  if (!symbol) {
    return apiError('VALIDATION_ERROR', '缺少 symbol 参数', 400);
  }

  cleanupCache();

  const cacheKey = symbol;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return apiSuccess({ ...cached.data, cached: true });
  }

  // okxId 缺失时从币种表查
  let resolvedOkxId = okxId;
  if (!resolvedOkxId) {
    const sym = await prisma.tradingSymbol.findUnique({ where: { symbol } });
    if (!sym) {
      return apiError('NOT_FOUND', `币种 ${symbol} 不存在`, 404);
    }
    resolvedOkxId = sym.okxId;
  }

  const data = await analyzeTrend(symbol, resolvedOkxId, symbol);
  cache.set(cacheKey, { data, at: Date.now() });

  return apiSuccess({ ...data, cached: false });
});
