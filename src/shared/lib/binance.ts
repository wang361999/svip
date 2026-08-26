// 服务端 fallback：当浏览器直连失败时，通过服务端代理获取
// 多源策略：公共数据镜像优先（data-api.binance.vision 不受地域封锁，
// 主站 api.binance.com 对受限地区/香港出口返回 451），OKX 兜底

export interface KlineData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];

// Helper: fetch with timeout
async function fetchWithTimeout(url: string, timeoutMs: number = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 按端点列表依次请求，返回第一个成功的 JSON，全失败返回 null */
async function fetchJsonMultiHost(
  path: string,
  hosts: string[],
  timeoutMs: number,
): Promise<any | null> {
  for (const host of hosts) {
    try {
      const response = await fetchWithTimeout(`${host}${path}`, timeoutMs);
      if (!response.ok) continue;
      return await response.json();
    } catch {
      continue; // 换下一个源
    }
  }
  return null;
}

// Get historical klines from Binance REST API
export async function getHistoricalKlines(
  symbol: string,
  interval: string,
  limit: number = 500,
): Promise<KlineData[]> {
  try {
    const data = await fetchJsonMultiHost(
      `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      BINANCE_HOSTS,
      10000,
    );
    if (!Array.isArray(data)) return [];

    return data.map((kline: any[]) => ({
      time: kline[0] / 1000,
      open: parseFloat(kline[1]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
      close: parseFloat(kline[4]),
      volume: parseFloat(kline[5]),
    }));
  } catch (error: any) {
    console.error('Binance klines failed:', error.message);
    return [];
  }
}

// Get 24hr statistics
export async function get24hrStats(symbol: string) {
  try {
    const data = await fetchJsonMultiHost(
      `/api/v3/ticker/24hr?symbol=${symbol}`,
      BINANCE_HOSTS,
      8000,
    );
    if (!data || !data.lastPrice) {
      return {
        price: 0,
        change: 0,
        changePercent: '0',
        volume: 0,
        high: 0,
        low: 0,
      };
    }

    return {
      price: parseFloat(data.lastPrice),
      change: parseFloat(data.priceChange),
      changePercent: data.priceChangePercent,
      volume: parseFloat(data.volume),
      high: parseFloat(data.highPrice),
      low: parseFloat(data.lowPrice),
    };
  } catch (error: any) {
    console.error('Binance 24hr stats failed:', error.message);
    return {
      price: 0,
      change: 0,
      changePercent: '0',
      volume: 0,
      high: 0,
      low: 0,
    };
  }
}
