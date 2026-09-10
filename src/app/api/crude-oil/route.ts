/**
 * 原油信号 API（CNBC 单一数据源：实时报价 + 日K历史，全程无需 key）
 *
 * GET /api/crude-oil — WTI + 布伦特原油实时行情与多空观望信号
 *
 * 数据源（均为 CNBC 公开网页端接口，无需鉴权）：
 *   1. 实时报价 quote.cnbc.com restQuote：
 *      @CL.1（WTI 前月合约）+ @LCO.1（布伦特前月合约），一次请求双品种
 *   2. 日K历史 ts-api.cnbc.com harmony 图表接口：
 *      /harmony/app/charts/1Y.json?symbol=@CL.1 → 近两年日线收盘
 *      与实时报价同一合约，日K close 与报价 settlePrice 完全一致（口径统一）
 *
 * 3 日涨跌幅 = 实时价 vs 3 个交易日前日K收盘（同源同合约，无跨源误差）
 *
 * 多空观望信号：
 *   3 日涨 > 3% → short（通胀恐慌，加密币跌）
 *   3 日跌 > 3% → long（避险消退，加密币涨）
 *   其他 → neutral（观望）
 *
 * 兜底链（防 Vercel 出口 IP 被 Akamai 封锁，参照 macro-live.json 模式）：
 *   日K：运行时直连 ts-api → src/data/oil-history.json
 *        （GitHub Actions 每 30 分钟用同一接口刷新，见 scripts/update-macro.mjs）
 *        → 两者都不可用时降级用当日涨跌幅（CNBC change_pct）
 *   报价：拉取失败时返回上一次成功的内存缓存（即使已过期），保证前端不闪断
 */
import { createHandler } from '@/shared/api/handler';
import { apiSuccess, apiError } from '@/shared/api/response';
import { requireUser } from '@/shared/api/auth-guard';
import oilHistoryJson from '@/data/oil-history.json';

export const dynamic = 'force-dynamic';

// 报价内存缓存：30 秒（CNBC 报价约 1 分钟内多次刷新，30 秒足以体现实时性）
let cache: { data: any; ts: number } | null = null;
const CACHE_TTL = 30 * 1000;

// 日K内存缓存：10 分钟（日线数据盘中基本不变，仅结算时更新一根）
let chartCache: { closes: DailyClose[]; ts: number } | null = null;
const CHART_TTL = 10 * 60 * 1000;

// 日K允许的最大滞后：超过 14 天视为过期（覆盖长假），弃用降级
const HISTORY_MAX_STALE_MS = 14 * 24 * 3600 * 1000;

// CNBC 实时报价端点（无需鉴权，partnerId=2 为网页端公开参数）
const CNBC_QUOTE_URL =
  'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol' +
  '?symbols=%40CL.1%7C%40LCO.1&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';

// CNBC 图表日K端点（harmony 接口，symbol 需 URL 编码，返回近两年日线）
const CNBC_CHART_URL =
  'https://ts-api.cnbc.com/harmony/app/charts/1Y.json?symbol=' + encodeURIComponent('@CL.1');

const CNBC_HEADERS: Record<string, string> = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

async function fetchWithTimeout(url: string, ms = 5000, headers?: Record<string, string>): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers,
      // CNBC 对代理缓存敏感，绕过 Next.js fetch 缓存
      cache: 'no-store',
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

interface CNBCQuote {
  price: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  prevClose: number;
  lastTimeMs: number;
  marketStatus: string;
  name: string;
  exchange: string;
}

/** 日K收盘点（ts-api 直连或 Actions 刷新的本地文件，同一结构） */
interface DailyClose {
  date: string; // YYYY-MM-DD
  close: number;
}

/** 数值解析：CNBC 返回 "100.03"、"+3.98"、"162,712" 这类字符串 */
function parseNum(v: any): number {
  if (v == null) return NaN;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 拉取 CNBC 实时报价（WTI @CL.1 + 布伦特 @LCO.1 一次请求）
 * 成功标志：code === 0 且 last > 0
 */
async function fetchCNBCQuotes(): Promise<{ wti: CNBCQuote; brent: CNBCQuote } | null> {
  const json = await fetchWithTimeout(CNBC_QUOTE_URL, 6000, CNBC_HEADERS);
  const quotes = json?.FormattedQuoteResult?.FormattedQuote;
  if (!Array.isArray(quotes)) return null;

  const parsed: Record<string, CNBCQuote> = {};
  for (const q of quotes) {
    if (!q || q.code !== 0) continue;
    const price = parseNum(q.last);
    if (!(price > 0)) continue;

    let lastTimeMs = 0;
    if (q.last_time) {
      const d = new Date(q.last_time);
      if (!isNaN(d.getTime())) lastTimeMs = d.getTime();
    }

    parsed[q.symbol] = {
      price,
      change: parseNum(q.change),
      changePct: parseNum(q.change_pct),
      open: parseNum(q.open),
      high: parseNum(q.high),
      low: parseNum(q.low),
      volume: parseNum(q.volume),
      prevClose: parseNum(q.previous_day_closing),
      lastTimeMs,
      marketStatus: String(q.curmktstatus || ''),
      name: String(q.name || ''),
      exchange: String(q.exchange || ''),
    };
  }

  const wti = parsed['@CL.1'];
  const brent = parsed['@LCO.1'];
  if (!wti) return null; // WTI 是主力显示品种，必须有
  return { wti, brent: brent ?? wti }; // 布伦特缺失时退化为 WTI（仅附加展示用）
}

/**
 * 拉取 CNBC 日K收盘序列（ts-api harmony 图表接口，@CL.1 近两年日线）
 * bar 结构：{ open, high, low, close, volume, tradeTime, tradeTimeinMills }
 * 按时间升序返回 [{date, close}]
 */
async function fetchCNBCDailyCloses(): Promise<DailyClose[]> {
  const json = await fetchWithTimeout(CNBC_CHART_URL, 8000, {
    ...CNBC_HEADERS,
    'Referer': 'https://www.cnbc.com/quotes/@CL.1',
  });
  const bars = json?.barData?.priceBars;
  if (!Array.isArray(bars)) throw new Error('chart payload 异常');

  const closes: DailyClose[] = [];
  for (const b of bars) {
    const close = parseNum(b?.close);
    const ms = Number(b?.tradeTimeinMills);
    if (!(close > 0) || !Number.isFinite(ms) || ms <= 0) continue;
    closes.push({ date: new Date(ms).toISOString().slice(0, 10), close });
  }
  if (closes.length < 4) throw new Error('日K不足 4 根');
  return closes;
}

/** 本地兜底日K（GitHub Actions 定时刷新的 src/data/oil-history.json） */
function getFallbackCloses(): DailyClose[] {
  return (oilHistoryJson.wti || [])
    .filter((p: any) => p && typeof p.date === 'string' && typeof p.price === 'number' && p.price > 0)
    .map((p: any) => ({ date: p.date, close: p.price }));
}

/** 美东当前日期（YYYY-MM-DD）：判断日K最后一根是否为今日进行中的 bar */
function etToday(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  } catch {
    return '';
  }
}

/** 序列是否过期（最后一根日K距今超过 14 天，覆盖长假场景） */
function isStale(closes: DailyClose[]): boolean {
  if (closes.length === 0) return true;
  const lastMs = new Date(`${closes[closes.length - 1].date}T00:00:00Z`).getTime();
  return !Number.isFinite(lastMs) || Date.now() - lastMs > HISTORY_MAX_STALE_MS;
}

/**
 * 3 日涨跌幅：实时价 vs 3 个交易日前日K收盘（同一合约，口径一致）
 *   日K最后一根 = 今日（进行中）→ 基准取倒数第 4 根
 *   日K最后一根 = 昨日及更早   → 基准取倒数第 3 根（今日实时价虚拟为最新一根）
 * 历史不可用（冷启动/接口全挂）→ 降级用 CNBC 当日涨跌幅
 */
function calcChange3d(closes: DailyClose[], wti: CNBCQuote): {
  change3d: number;
  changePct3d: number;
  history: number[];
  historyBased: boolean;
} {
  if (closes.length >= 4) {
    const lastIsToday = closes[closes.length - 1].date === etToday();
    const base = closes[closes.length - (lastIsToday ? 4 : 3)].close;
    if (base > 0) {
      const change3d = wti.price - base;
      return {
        change3d,
        changePct3d: (change3d / base) * 100,
        history: closes.slice(-10).map((c) => c.close),
        historyBased: true,
      };
    }
  }

  // 降级：当日涨跌幅（CNBC 提供相对昨收的涨跌）
  return {
    change3d: wti.change,
    changePct3d: wti.changePct,
    history: closes.slice(-10).map((c) => c.close),
    historyBased: false,
  };
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

  // 命中缓存直接返回
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return apiSuccess(cache.data);
  }

  let quotes: { wti: CNBCQuote; brent: CNBCQuote } | null = null;
  try {
    quotes = await fetchCNBCQuotes();
  } catch {
    quotes = null;
  }

  // CNBC 报价失败：兜底返回过期缓存（数据稍旧但真实，好过报错闪断）
  if (!quotes) {
    if (cache) {
      return apiSuccess({ ...cache.data, stale: true });
    }
    return apiError('OIL_FETCH_FAILED', '原油数据获取失败（CNBC 接口不可达），请稍后重试', 502);
  }

  // 日K：内存缓存 → ts-api 直连 → 本地文件，全部失败则降级当日口径
  let closes: DailyClose[] = [];
  if (chartCache && Date.now() - chartCache.ts < CHART_TTL) {
    closes = chartCache.closes;
  } else {
    try {
      closes = await fetchCNBCDailyCloses();
      chartCache = { closes, ts: Date.now() };
    } catch {
      closes = [];
    }
  }
  if (closes.length === 0 || isStale(closes)) {
    const fallback = getFallbackCloses();
    if (!isStale(fallback)) closes = fallback;
    else closes = [];
  }

  const { wti, brent } = quotes;
  const { change3d, changePct3d, history, historyBased } = calcChange3d(closes, wti);
  const signal = getOilSignal(changePct3d);

  const result = {
    // WTI 主力
    price: wti.price,
    change: wti.change,
    changePct: wti.changePct,
    open: wti.open,
    high: wti.high,
    low: wti.low,
    volume: wti.volume,
    prevClose: wti.prevClose,
    // 3 日信号（保持原有字段名，前端兼容）
    change3d,
    changePct3d,
    historyBased, // true = 日K 3 日口径；false = 降级当日口径
    history,
    signal: signal.signal,
    label: signal.label,
    color: signal.color,
    // 布伦特（附加）
    brentPrice: brent.price,
    brentChangePct: brent.changePct,
    // 元信息
    source: `CNBC 实时+日K（${wti.name || 'WTI'}，${wti.exchange || 'NYMEX'}）`,
    marketStatus: wti.marketStatus, // REG_MKT=盘中 PRE_MKT=盘前 POST_MKT=盘后 CLOSED=休市
    lastTime: wti.lastTimeMs, // 交易所行情时间戳（毫秒）
    updatedAt: Date.now(),
  };

  cache = { data: result, ts: Date.now() };
  return apiSuccess(result);
});
