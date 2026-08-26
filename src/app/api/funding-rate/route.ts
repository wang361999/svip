import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';

export const dynamic = 'force-dynamic';

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

  // Binance Futures premiumIndex（资金费率）
  try {
    const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;
    const data = await fetchWithTimeout(url);
    if (data && data.lastFundingRate !== undefined) {
      return apiSuccess({ symbol, fundingRate: parseFloat(data.lastFundingRate) });
    }
  } catch {}

  return apiError('FUNDING_RATE_UNAVAILABLE', '资金费率数据暂时不可用', 502);
});
