// 服务端 fallback：当浏览器直连失败时，通过服务端代理获取
// 注意：Vercel 服务器在中国大陆可能无法访问 Binance

export interface KlineData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

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

// Get historical klines from Binance REST API
export async function getHistoricalKlines(
  symbol: string,
  interval: string,
  limit: number = 500,
): Promise<KlineData[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const response = await fetchWithTimeout(url, 15000);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error('Invalid response');
    }

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
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`;
    const response = await fetchWithTimeout(url, 10000);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

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
