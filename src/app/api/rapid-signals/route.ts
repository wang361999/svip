/**
 * 快速信号 API
 *
 * GET /api/rapid-signals?symbol=ETHUSDT
 *
 * 流程：拉 15m K 线（200 根）→ 快速策略引擎扫描 4 路信号 → 返回
 * 前端每 15 秒轮询（15m 周期，15 秒够用）
 * 缓存：15 秒（数字层实时性 + 保护上游 K 线接口）
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { analyzeRapid, KlineData } from '@/shared/lib/rapid-strategy';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ==================== K 线获取（多源 fallback） ====================

const KLINES_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];

async function fetchKlines15m(symbol: string, limit: number = 200): Promise<KlineData[]> {
  for (const host of KLINES_HOSTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `${host}/api/v3/klines?symbol=${symbol}&interval=15m&limit=${limit}`,
        { signal: controller.signal, headers: { Accept: 'application/json' } },
      );
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data) || data.length < 50) continue;
      return data.map((k: unknown[]) => ({
        time: (k[0] as number) / 1000,
        open: parseFloat(k[1] as string),
        high: parseFloat(k[2] as string),
        low: parseFloat(k[3] as string),
        close: parseFloat(k[4] as string),
        volume: parseFloat(k[5] as string),
      }));
    } catch {
      continue;
    }
  }
  return [];
}

// ==================== 缓存（15 秒） ====================

const CACHE_TTL_MS = 15 * 1000;
const cache = new Map<string, { data: unknown; expiresAt: number }>();

// ==================== 主逻辑 ====================

export const GET = createHandler(async ({ req }) => {
  requireUser();

  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') || 'ETHUSDT').toUpperCase();

  // 缓存命中
  const hit = cache.get(symbol);
  if (hit && Date.now() < hit.expiresAt) {
    return apiSuccess({ ...hit.data, cached: true });
  }

  // 拉 15m K 线
  const klines = await fetchKlines15m(symbol, 200);

  if (klines.length < 60) {
    return apiError('KLINE_UNAVAILABLE', '行情数据源暂不可用，请稍后重试', 502);
  }

  // 快速策略分析
  const analysis = analyzeRapid(symbol, klines);

  // 写缓存
  cache.set(symbol, { data: analysis, expiresAt: Date.now() + CACHE_TTL_MS });

  return apiSuccess({ ...analysis, cached: false });
});
