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
 * 数据源：
 *   1. Yahoo Finance CL=F (WTI 原油期货) — Vercel 服务器可能可达
 *   2. OilPriceAPI (需要 API key，环境变量 OIL_PRICE_API_KEY)
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
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

/**
 * 从多个源拉取真实原油数据
 * 不使用 ETH 等替代品冒充原油
 */
async function fetchCrudeOil(): Promise<{ price: number; change3d: number; changePct3d: number; history: number[]; source: string } | null> {
  // 方案1: Yahoo Finance WTI 原油期货 (CL=F)
  try {
    const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=5d';
    const data = await fetchWithTimeout(yahooUrl, 5000);
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
  } catch {
    // Yahoo 可能被封，继续尝试下一个源
  }

  // 方案2: OilPriceAPI (需要 API key)
  const oilApiKey = process.env.OIL_PRICE_API_KEY;
  if (oilApiKey) {
    try {
      const url = 'https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD';
      const data = await fetchWithTimeout(url, 5000, {
        'Authorization': `Token ${oilApiKey}`,
      });
      if (data?.data?.price) {
        const latest = data.data.price;
        // OilPriceAPI 返回最新价格，但没有历史数据
        // 拿不到 3 日涨跌幅，仅用当前价格做参考
        return { price: latest, change3d: 0, changePct3d: 0, history: [latest], source: 'OilPriceAPI' };
      }
    } catch {
      // API key 可能无效
    }
  }

  // 所有真实数据源都失败，返回 null（不使用假数据）
  return null;
}

function getOilSignal(changePct3d: number): { signal: 'long' | 'short' | 'neutral'; label: string; color: string } {
  if (changePct3d > 3) {
    // 原油大涨 → 通胀恐慌 → 加密币承压 → 偏空
    return { signal: 'short', label: '原油涨 偏空', color: 'rgba(246, 70, 93, 1)' };
  } else if (changePct3d < -3) {
    // 原油大跌 → 避险消退 → 加密币利好 → 偏多
    return { signal: 'long', label: '原油跌 偏多', color: 'rgba(34, 197, 94, 1)' };
  } else {
    // 波动不大 → 观望
    return { signal: 'neutral', label: '原油稳 观望', color: 'rgba(148, 163, 184, 1)' };
  }
}

export const GET = createHandler(async () => {
  requireUser();

  // 检查缓存
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return apiSuccess(cache.data);
  }

  const oilData = await fetchCrudeOil();
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
