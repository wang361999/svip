import { NextResponse } from 'next/server';
import { createHandler } from '@/shared/api/handler';
import { apiError } from '@/shared/api/response';

export const dynamic = 'force-dynamic';

const FAPI_HOSTS = ['https://fapi.binance.com', 'https://data-api.binance.vision'];
const VALID_PERIOD = new Set(['1h', '1d']);
const BAR_MS: Record<string, number> = { '1h': 3600000, '1d': 86400000 };

async function get(path: string, ms = 6000): Promise<any> {
  // 多主机失败转移：主站深圳受限（含香港451），镜像优先也试
  for (const host of FAPI_HOSTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const resp = await fetch(`${host}${path}`, {
        signal: controller.signal,
        headers: { 'user-agent': 'ETH-Trading-Vercel-Proxy/1.0', 'accept': 'application/json' },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch {
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('all-fapi-hosts-failed');
}

export const GET = createHandler(async ({ req }) => {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') || 'ETHUSDT';
  const period = VALID_PERIOD.has(searchParams.get('period') || '') ? searchParams.get('period')! : '1h';
  const want = Math.max(60, Math.min(500, parseInt(searchParams.get('limit') || '350') || 350));
  const barMs = BAR_MS[period];

  const out: any = { symbol, period, source: 'binance', funding: null, fundingOkx: null, oi: null, taker: null, now: null };

  // 资金费率历史：约 8h 一根，最多要 800 根（约 267 天）
  try {
    const fr = await get(`/fapi/v1/fundingRate?symbol=${symbol}&limit=${Math.min(want * 3, 800)}`);
    if (Array.isArray(fr) && fr.length) {
      out.funding = fr.map((r: any) => ({ time: r.fundingTime, rate: parseFloat(r.fundingRate) }));
    }
  } catch {}

  // OKX 资金费率（双源对照）：instId 如 ETH-USDT-SWAP
  try {
    const inst = symbol.replace('USDT', '-USDT-SWAP');
    const r = await fetch(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=${Math.min(want, 100)}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'user-agent': 'ETH-Trading-Vercel-Proxy/1.0' },
    });
    const o = r.ok ? (await r.json()) as any : null;
    if (o?.code === '0' && Array.isArray(o.data) && o.data.length) {
      out.fundingOkx = o.data.map((x: any) => ({ time: parseInt(x.fundingTime), rate: parseFloat(x.fundingRate) }));
    }
  } catch {}

  // OI / 主动买卖比：用 startTime 拉到 want 根（支持端数据接口单次最多500）
  const startTime = Date.now() - want * barMs;
  try {
    const oi = await get(`/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${Math.min(want, 500)}&startTime=${startTime}`);
    if (Array.isArray(oi) && oi.length) {
      out.oi = oi.map((r: any) => ({ time: r.timestamp, oi: parseFloat(r.sumOpenInterest || r.sumOpenInterestValue || '0') }));
    }
  } catch {}
  try {
    const tk = await get(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${Math.min(want, 500)}&startTime=${startTime}`);
    if (Array.isArray(tk) && tk.length) {
      out.taker = tk.map((r: any) => ({
        time: r.timestamp,
        buyVol: parseFloat(r.buyVol || '0'),
        sellVol: parseFloat(r.sellVol || '0'),
        ratio: parseFloat(r.buySellRatio || '0'),
      }));
    }
  } catch {}

  try {
    const curFunding = await get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    const curOi = await get(`/fapi/v2/openInterest?symbol=${symbol}`);
    out.now = {
      funding: curFunding && curFunding.lastFundingRate != null ? parseFloat(curFunding.lastFundingRate) : null,
      nextFundingTime: curFunding ? curFunding.nextFundingTime || null : null,
      oi: curOi && curOi.openInterest != null ? parseFloat(curOi.openInterest) : null,
    };
  } catch {}

  if (!out.funding && !out.oi && !out.taker) {
    return apiError('MARKET_UNAVAILABLE', '资金费/持仓数据源暂时不可用', 502);
  }
  return NextResponse.json(out, {
    headers: { 'Cache-Control': 'no-store', 'X-Data-Source': 'binance-futures' },
  });
});