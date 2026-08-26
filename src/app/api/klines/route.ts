import { NextResponse } from 'next/server';
import { createHandler } from '@/shared/api/handler';
import { apiError } from '@/shared/api/response';

export const dynamic = 'force-dynamic';

const VALID_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d']);
const OKX_BAR_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '4h': '4H', '1d': '1D',
};

// Binance 现货多端点：公共数据镜像优先（不受地域封锁，Vercel hkg1 出口稳定可达），
// 主站 API 在受限地区（含香港）返回 451，仅作次选
const BINANCE_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
];

async function fetchWithTimeout(url: string, ms = 3500): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'ETH-Trading-Vercel-Proxy/1.0', 'accept': 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export const GET = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || 'ETHUSDT';
  const okxId = searchParams.get('okxId') || symbol.replace('USDT', '-USDT');
  const interval = VALID_INTERVALS.has(searchParams.get('interval') || '')
    ? searchParams.get('interval')!
    : '1h';
  const limit = Math.max(50, Math.min(1000, parseInt(searchParams.get('limit') || '500')));

  // 1. Binance（镜像 → 主站 → api1）
  for (const host of BINANCE_HOSTS) {
    try {
      const url = `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const data = await fetchWithTimeout(url);
      if (Array.isArray(data) && data.length > 0) {
        return NextResponse.json(data, {
          headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'binance' },
        });
      }
    } catch {}
  }

  // 2. OKX fallback
  try {
    const bar = OKX_BAR_MAP[interval] || '1H';
    const url = `https://www.okx.com/api/v5/market/candles?instId=${okxId}&bar=${bar}&limit=${Math.min(limit, 300)}`;
    const json = await fetchWithTimeout(url);
    if (json?.code === '0' && Array.isArray(json.data) && json.data.length > 0) {
      const data = json.data.reverse().map((row: any[]) => [
        parseInt(row[0]), row[1], row[2], row[3], row[4], row[5] || '0',
        parseInt(row[0]), '0', 0, '0', '0', '0',
      ]);
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'okx' },
      });
    }
  } catch {}

  return apiError('MARKET_UNAVAILABLE', 'K线数据源暂时不可用', 502);
});
