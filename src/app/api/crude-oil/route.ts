/**
 * 原油信号 API
 *
 * GET /api/crude-oil — 拉取 WTI 原油实时价格 + 历史数据
 * 返回多空观望信号：
 *   涨 > 3% → short（通胀恐慌，加密币跌）
 *   跌 > 3% → long（避险消退，加密币涨）
 *   其他 → neutral（观望）
 *
 * 服务端 5 分钟缓存
 *
 * 数据源：
 *   主力: OilPriceAPI 实时价格(latest) + 5日历史(historical) 合并
 *   备用: Yahoo Finance CL=F
 *   失败则返回错误，不使用假数据
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 300; // 5 分钟

// 内存缓存
let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

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
 * 主力：同时拉 OilPriceAPI 的实时价格 + 5日历史
 * 用实时价格显示，用历史数据算 3 日涨跌幅
 */
async function fetchOilPriceAPICombined(): Promise<{ price: number; change3d: number; changePct3d: number; history: number[]; source: string } | null> {
  if (!OIL_API_KEY) return null;

  // 并行请求实时价格和历史数据
  const [latestRes, histRes] = await Promise.allSettled([
    fetchWithTimeout('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', 5000, {
      'Authorization': `Token ${OIL_API_KEY}`,
    }),
    fetchWithTimeout('https://api.oilpriceapi.com/v1/prices/historical?by_code=WTI_USD&days=5', 5000, {
      'Authorization': `Token ${OIL_API_KEY}`,
    }),
  ]);

  // 取实时价格（主力显示用）
  let price = 0;
  let change3d = 0;
  let changePct3d = 0;
  let history: number[] = [];
  let hasLatest = false;

  if (latestRes.status === 'fulfilled') {
    const data = latestRes.value?.data;
    if (data?.price) {
      price = data.price;
      hasLatest = true;
      // 24h 涨跌幅作为备用
      const ch24 = data.changes?.['24h'];
      change3d = ch24?.amount ?? 0;
      changePct3d = ch24?.percent ?? 0;
    }
  }

  // 取历史数据（算 3 日涨跌幅）
  let hasHistory = false;
  if (histRes.status === 'fulfilled') {
    const prices = histRes.value?.data?.prices;
    if (Array.isArray(prices) && prices.length >= 4) {
      const closes = prices.map((p: any) => p.price).reverse();
      history = closes;
      // 用历史数据的最新日均价算 3 日涨跌幅
      const histLatest = closes[closes.length - 1];
      const price3dAgo = closes[closes.length - 4];
      change3d = histLatest - price3dAgo;
      changePct3d = (change3d / price3dAgo) * 100;
      hasHistory = true;
      // 如果没有实时价格，用历史最新日均价
      if (!hasLatest) price = histLatest;
    }
  }

  if (hasLatest || hasHistory) {
    return {
      price,
      change3d,
      changePct3d,
      history,
      source: hasLatest ? 'OilPriceAPI (WTI 实时)' : 'OilPriceAPI (WTI 日均)',
    };
  }

  return null;
}

/**
 * 备用：Yahoo Finance CL=F
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
    (await fetchOilPriceAPICombined()) ||
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
