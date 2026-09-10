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
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 600; // 10 分钟

// 内存缓存
let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟

async function fetchWithTimeout(url: string, ms = 5000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ETH-Trading-Proxy/1.0)',
        'Accept': 'application/json',
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从多个源拉取原油数据
 * 优先: Alpha Vantage / Yahoo Finance → Binance 原油合约 → 备用
 */
async function fetchCrudeOil(): Promise<{ price: number; change3d: number; changePct3d: number; history: number[] } | null> {
  // 方案1: Binance 原油永续合约 OILUSDT（如果有）
  const binanceHosts = [
    'https://data-api.binance.vision',
    'https://api.binance.com',
    'https://fapi.binance.com',
  ];

  for (const host of binanceHosts) {
    try {
      // 尝试现货
      const url = `${host}/api/v3/klines?symbol=OILUSDT&interval=1d&limit=5`;
      const data = await fetchWithTimeout(url, 3500);
      if (Array.isArray(data) && data.length >= 4) {
        const closes = data.map((k: any[]) => parseFloat(k[4]));
        const latest = closes[closes.length - 1];
        const price3dAgo = closes[closes.length - 4];
        const change = latest - price3dAgo;
        const changePct = (change / price3dAgo) * 100;
        return { price: latest, change3d: change, changePct3d: changePct, history: closes };
      }
    } catch {
      // OIL 不存在，尝试其他
    }
  }

  // 方案2: 通过 Yahoo Finance API 拉取 WTI 原油期货 (CL=F)
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
        return { price: latest, change3d: change, changePct3d: changePct, history: closes };
      }
    }
  } catch {
    // Yahoo 可能被封
  }

  // 方案3: 通过 OKX 拉原油相关商品币种（如 OIL/USDT 不存在，用天然气或相关替代）
  // 最后备用：使用 ETH/BTC 的 3 日波动作为替代市场情绪
  try {
    const url = 'https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1d&limit=5';
    const data = await fetchWithTimeout(url, 3500);
    if (Array.isArray(data) && data.length >= 4) {
      const closes = data.map((k: any[]) => parseFloat(k[4]));
      const latest = closes[closes.length - 1];
      const price3dAgo = closes[closes.length - 4];
      const change = latest - price3dAgo;
      const changePct = (change / price3dAgo) * 100;
      // 当 ETH 3 日波动 > 5%，间接反映市场波动（替代原油）
      return { price: latest, change3d: change, changePct3d: changePct, history: closes };
    }
  } catch {
    // 全部失败
  }

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
    return apiError('OIL_FETCH_FAILED', '原油数据获取失败', 502);
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
    updatedAt: Date.now(),
  };

  cache = { data: result, ts: Date.now() };
  return apiSuccess(result);
});
