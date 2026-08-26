import { NextResponse } from 'next/server';
import { createHandler } from '@/shared/api/handler';
import { apiError } from '@/shared/api/response';

export const dynamic = 'force-dynamic';

// Binance 多端点：公共数据镜像优先（不受地域封锁），主站在受限地区返回 451
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

  // 1. Binance（镜像 → 主站 → api1）
  for (const host of BINANCE_HOSTS) {
    try {
      const j = await fetchWithTimeout(`${host}/api/v3/ticker/price?symbol=${symbol}`);
      const price = parseFloat(j?.price);
      if (price > 0) {
        return NextResponse.json(
          { symbol, price, source: 'binance', time: Date.now() },
          { headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'binance' } },
        );
      }
    } catch {}
  }

  // 2. OKX fallback
  try {
    const j = await fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${okxId}`);
    const price = parseFloat(j?.data?.[0]?.last);
    if (price > 0) {
      return NextResponse.json(
        { symbol, price, source: 'okx', time: Date.now() },
        { headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'okx' } },
      );
    }
  } catch {}

  return apiError('MARKET_UNAVAILABLE', '行情源暂时不可用', 502);
});
