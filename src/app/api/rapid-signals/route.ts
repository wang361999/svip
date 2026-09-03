/**
 * 快速信号 API
 *
 * GET /api/rapid-signals?symbol=ETHUSDT&timeframe=15m
 *
 * 流程：拉指定周期 K 线（200 根）→ 快速策略引擎扫描 4 路信号 → 返回
 * 前端每 15 秒轮询
 * 缓存：15 秒（按 symbol+timeframe 分别缓存）
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import { analyzeRapid, KlineData, type RapidAnalysis } from '@/shared/lib/rapid-strategy';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// ==================== K 线获取（多源 fallback） ====================

const KLINES_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];

const VALID_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

async function fetchKlines(symbol: string, interval: string, limit: number = 200): Promise<KlineData[]> {
  for (const host of KLINES_HOSTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(
        `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
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
const cache = new Map<string, { data: RapidAnalysis; expiresAt: number }>();

// ==================== 主逻辑 ====================

export const GET = createHandler(async ({ req }) => {
  requireUser();

  const url = new URL(req.url);
  const symbol = (url.searchParams.get('symbol') || 'ETHUSDT').toUpperCase();
  const timeframeParam = url.searchParams.get('timeframe') || '15m';
  const interval = VALID_INTERVALS.includes(timeframeParam) ? timeframeParam : '15m';
  const cacheKey = `${symbol}:${interval}`;

  // 缓存命中
  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) {
    return apiSuccess({ ...hit.data, cached: true });
  }

  // 拉指定周期 K 线
  const klines = await fetchKlines(symbol, interval, 200);

  if (klines.length < 60) {
    return apiError('KLINE_UNAVAILABLE', '行情数据源暂不可用，请稍后重试', 502);
  }

  // 快速策略分析
  const analysis = analyzeRapid(symbol, klines);

  // 写缓存
  cache.set(cacheKey, { data: analysis, expiresAt: Date.now() + CACHE_TTL_MS });

  return apiSuccess({ ...analysis, cached: false });
});
