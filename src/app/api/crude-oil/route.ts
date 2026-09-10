/**
 * 原油信号 API
 *
 * GET /api/crude-oil — 拉取 WTI 原油近 5 日数据，计算 3 日涨跌幅
 * 返回多空观望信号：
 *   涨 > 3% → short（通胀恐慌，加密币跌）
 *   跌 > 3% → long（避险消退，加密币涨）
 *   其他 → neutral（观望）
 *
 * 服务端 10 分钟缓存
 *
 * 数据源（优先级）：
 *   1. OilPriceAPI 历史数据（5日） → 算 3 日涨跌幅
 *   2. OilPriceAPI 最新价格 → 用 24h 涨跌幅
 *   3. Yahoo Finance CL=F（备用）
 *   失败则返回错误，不使用假数据
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 600; // 10 分钟

// 内存缓存
let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟

async function fetchWithTimeout(url: string, ms = 5000, headers?: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

const OIL_API_KEY = process.env.OIL_PRICE_API_KEY || '1f88da035b3fca28a99048abd0f139a87be86be1e9c804db784dfe93b3d0bf53';

/**
 * 方案1: OilPriceAPI 历史数据（5日 daily average）
 * 返回每天的日均价，可以算 3 日涨跌幅
 */
async function fetchOilPriceAPIHistory(): Promise<{ price: number; change3d: number; changePct3d: number; history: number[]; source: string } | null> {
  if (!OIL_API_KEY) return null;
  try {
    const url = 'https://api.oilpriceapi.com/v1/prices/historical?by_code=WTI_USD&days=5';
    const data = await fetchWithTimeout(url, 5000, {
      'Authorization': `Token ${OIL_API_KEY}`,
    });
    const prices = data?.data?.prices;
    if (Array.isArray(prices) && prices.length >= 4) {
      // 历史数据按日期升序排列（旧→新）
      const closes = prices.map((p: any) => p.price).reverse();
      const latest = closes[closes.length - 1];
      const price3dAgo = closes[closes.length - 4];
      const change = latest - price3dAgo;
      const changePct = (change / price3dAgo) * 100;
      return { price: latest, change3d: change, changePct3d: changePct, history: closes, source: 'OilPriceAPI (WTI 5d)' };
    }
  } catch {}
  return null;
}

/**
 * 方案2: OilPriceAPI 最新价格（含 24h 涨跌幅）
 * 历史接口失败时，用 24h 数据做近似
 */
async function fetchOilPriceAPILatest(): Promise<{ price: number; change3d: number; changePct3d: number; history: number[]; source: string } | null> {
  if (!OIL_API_KEY) return null;
  try {
    const url = 'https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD';
    const data = await fetchWithTimeout(url, 5000, {
      'Authorization': `Token ${OIL_API_KEY}`,
    });
    if (data?.data?.price) {
      const latest = data.data.price;
      const change24h = data.data.changes?.['24h'];
      const change3d = change24h?.amount ?? 0;
      const changePct3d = change24h?.percent ?? 0;
      return { price: latest, change3d, changePct3d, history: [latest], source: 'OilPriceAPI (WTI 24h)' };
    }
  } catch {}
  return null;
}

/**
 * 方案3: Yahoo Finance CL=F（备用）
 */
async function fetchYahooFinance(): Promise<{ price: number; change3d: number; changePct3d: number; history: number[]; source: string } | null> {
  try {
    const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=5d';
    const data = await fetchWithTimeout(yahooUrl, 5000, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    if (data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close) {
      const closes = data.chart.result[0].indicators.quote[0].close.filter((c: number) => c != null);
      if (closes.length >= 4) {
        const latest = closes[closes.length - 1];
        const price3dAgo = closes[closes.length - 4];
        const change = latest - price3dAgo;
        const changePct = (change / price3dAgo) * 100;
        return { price: latest, change3d: change, changePct3d: changePct, history: closes, source: 'Yahoo Finance (CL=F)' };
      }
    }
  } catch {}
  return null;
}

function getOilSignal(changePct3d: number): { signal: 'long' | 'short' | 'neutral'; label: string; color: string } {
  if (changePct3d > 3) {
    return { signal: 'short', label: '原油涨 偏空', color: 'rgba(246, 70, 93, 1)' };
  } else if (changePct3d < -3) {
    return { signal: 'long', label: '原油跌 偏多', color: 'rgba(34, 197, 94, 1)' };
  } else {
    return { signal: 'neutral', label: '原油稳 观望', color: 'rgba(148, 163, 184, 1)' };
  }
}

export const GET = createHandler(async () => {
  requireUser();

  // 检查缓存
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return apiSuccess(cache.data);
  }

  // 按优先级尝试真实数据源
  const oilData =
    (await fetchOilPriceAPIHistory()) ||
    (await fetchOilPriceAPILatest()) ||
    (await fetchYahooFinance());

  if (!oilData) {
    return apiError('OIL_FETCH_FAILED', '原油数据获取失败，请稍后重试', 502);
  }

  const signal = getOilSignal(oilData.changePct3d);

  const result = {
    price: oilData.price,
    change3d: oilData.change3d,
    changePct3d: oilData.changePct3d,
    signal: signal.signal,
    label: signal.label,
    color: signal.color,
    history: oilData.history,
    source: oilData.source,
    updatedAt: Date.now(),
  };

  cache = { data: result, ts: Date.now() };
  return apiSuccess(result);
});
