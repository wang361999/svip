import { NextResponse } from 'next/server';
import { createHandler } from '@/shared/api/handler';
import { apiError } from '@/shared/api/response';

export const dynamic = 'force-dynamic';

// Binance USDT 永续 公开数据接口（无鉴权）
const FAPI = 'https://fapi.binance.com';
const VALID_PERIOD = new Set(['1h', '1d']);

async function get(path: string, ms = 4000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(`${FAPI}${path}`, {
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
  const period = VALID_PERIOD.has(searchParams.get('period') || '') ? searchParams.get('period')! : '1h';
  const limit = Math.max(30, Math.min(90, parseInt(searchParams.get('limit') || '60') || 60));

  const out: any = { symbol, period, source: 'binance', funding: null, oi: null, taker: null, now: null };

  // 1. 资金费率历史（ETH/BTC 永续约 8h/根）
  try {
    const fr = await get(`/fapi/v1/fundingRate?symbol=${symbol}&limit=${Math.min(limit, 100)}`);
    if (Array.isArray(fr) && fr.length) {
      out.funding = fr.map((r: any) => ({ time: r.fundingTime, rate: parseFloat(r.fundingRate) }));
    }
  } catch {}

  // 2. 未平仓量历史（period=1h 时 60 根；1d 时 30 根）
  try {
    const oi = await get(`/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`);
    if (Array.isArray(oi) && oi.length) {
      out.oi = oi.map((r: any) => ({ time: r.timestamp, oi: parseFloat(r.sumOpenInterest || r.sumOpenInterestValue || '0') }));
    }
  } catch {}

  // 3. 主动买卖比
  try {
    const tk = await get(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`);
    if (Array.isArray(tk) && tk.length) {
      out.taker = tk.map((r: any) => ({
        time: r.timestamp,
        buyVol: parseFloat(r.buyVol || '0'),
        sellVol: parseFloat(r.sellVol || '0'),
        ratio: parseFloat(r.buySellRatio || '0'),
      }));
    }
  } catch {}

  // 4. 当前值（若上面历史落空则尽量给当下）
  try {
    const [curFunding, curOi] = await Promise.all([
      get(`/fapi/v1/premiumIndex?symbol=${symbol}`),
      get(`/fapi/v2/openInterest?symbol=${symbol}`),
    ]);
    out.now = {
      funding: curFunding && curFunding.lastFundingRate ? parseFloat(curFunding.lastFundingRate) : null,
      nextFundingTime: curFunding ? curFunding.nextFundingTime || null : null,
      oi: curOi && curOi.openInterest ? parseFloat(curOi.openInterest) : null,
    };
  } catch {}

  if (!out.funding && !out.oi && !out.taker) {
    return apiError('MARKET_UNAVAILABLE', '资金费/持仓数据源暂时不可用', 502);
  }
  return NextResponse.json(out, {
    headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'binance-futures' },
  });
});