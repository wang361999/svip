/**
 * 市场上下文数据（衍生品 + 市场情绪 + 新闻要闻）
 *
 * 让 AI 分析在纯 K 线之外看到：
 * - 资金费率：多头/空头拥挤度（短线反抽风险的领先指标）
 * - 持仓量及 1 小时变化：验证突破真伪（增仓突破可信，缩量突破疑似陷阱）
 * - 恐惧贪婪指数：市场情绪背景
 * - 近期要闻标题：事件驱动（黑客/监管/大额清算常是短线急跌急涨的直接原因）
 *
 * 数据源（全部免费无 Key，失败优雅降级为 null）：
 * - 资金费率/持仓量：Binance fapi（主）→ OKX（备）
 * - 恐惧贪婪指数：api.alternative.me
 * - 要闻：Cointelegraph RSS
 *
 * 缓存策略（30 秒级 AI 轮询下避免打爆外部接口）：
 * - 衍生品数据：按币种缓存 5 分钟
 * - 恐惧贪婪：全局缓存 30 分钟
 * - 要闻：全局缓存 20 分钟
 * - 持仓量快照历史：内存保留 2 小时，用于计算 1 小时变化
 */

interface NewsItem {
  title: string;
  publishedAt: number; // epoch ms
  source: string;
}

export interface MarketContext {
  /** 8 小时资金费率（小数，0.00047 = 0.047%） */
  fundingRate8h: number | null;
  /** 当前持仓量（USD） */
  openInterestUsd: number | null;
  /** 1 小时持仓量变化 %（快照积累不足时为 null） */
  oiChange1hPct: number | null;
  /** 24 小时持仓量变化 %（价涨仓减=获利了结背离信号） */
  oiChange24hPct: number | null;
  /** 散户多空比（账户数口径，>1 多头账户占多） */
  longShortAccountRatio: number | null;
  /** 主动买卖多空比（taker 成交量口径，>1 主动买盘占优） */
  takerLongShortRatio: number | null;
  fearGreed: { value: number; classification: string } | null;
  news: NewsItem[];
}

// ==================== 基础工具 ====================

async function fetchJson(url: string, ms = 6000): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, ms = 6000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 缓存 ====================

const DERIV_TTL_MS = 5 * 60_000;
const FEAR_TTL_MS = 30 * 60_000;
const NEWS_TTL_MS = 20 * 60_000;

interface DerivData {
  fundingRate8h: number | null;
  openInterestUsd: number | null;
  longShortAccountRatio: number | null;
  takerLongShortRatio: number | null;
  oiChange24hPct: number | null;
}
const derivCache = new Map<string, { data: DerivData; at: number }>();
const fearCache = { data: null as MarketContext['fearGreed'], at: 0 };
const newsCache = { data: null as NewsItem[] | null, at: 0 };

/** 持仓量快照历史（symbol → 快照数组），用于计算 1 小时变化 */
const oiHistory = new Map<string, { t: number; oi: number }[]>();

// ==================== 衍生品数据（Binance 主 / OKX 备） ====================

async function fetchFundingAndOI(symbol: string, okxId: string): Promise<DerivData> {
  // --- Binance：premiumIndex 同时拿费率+标记价，openInterest 拿币本位持仓 ---
  const [premium, oi, lsAcc, lsTaker, oiHist] = await Promise.all([
    fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
    fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`),
    // 多空比（账户数口径 / 主动买卖口径）— 散户情绪的反向指标
    fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`).catch(() => null),
    fetchJson(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=1`).catch(() => null),
    // 持仓量 24h 历史（价涨仓减=获利了结 / 价涨仓增=趋势健康，关键背离证据）
    fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=1h&limit=25`).catch(() => null),
  ]);

  const lsAccount = Array.isArray(lsAcc) && lsAcc[0]?.longShortRatio != null
    ? parseFloat(lsAcc[0].longShortRatio) : null;
  const lsTakerVal = Array.isArray(lsTaker) && lsTaker[0]?.buySellRatio != null
    ? parseFloat(lsTaker[0].buySellRatio) : null;

  // 24h 持仓量变化：首末快照对比（币本位口径，与价格无关，直接可比）
  let oiChange24h: number | null = null;
  if (Array.isArray(oiHist) && oiHist.length >= 13) {
    const first = parseFloat(oiHist[0].sumOpenInterest);
    const lastOi = parseFloat(oiHist[oiHist.length - 1].sumOpenInterest);
    if (Number.isFinite(first) && Number.isFinite(lastOi) && first > 0) {
      oiChange24h = Number((((lastOi - first) / first) * 100).toFixed(2));
    }
  }

  if (premium && premium.lastFundingRate != null) {
    const rate = parseFloat(premium.lastFundingRate);
    let oiUsd: number | null = null;
    if (oi && oi.openInterest != null && premium.markPrice != null) {
      const oiCoin = parseFloat(oi.openInterest);
      const mark = parseFloat(premium.markPrice);
      if (Number.isFinite(oiCoin) && Number.isFinite(mark) && oiCoin > 0) {
        oiUsd = oiCoin * mark;
      }
    }
    if (Number.isFinite(rate)) {
      return {
        fundingRate8h: rate,
        openInterestUsd: oiUsd,
        longShortAccountRatio: Number.isFinite(lsAccount as number) ? lsAccount : null,
        takerLongShortRatio: Number.isFinite(lsTakerVal as number) ? lsTakerVal : null,
        oiChange24hPct: oiChange24h,
      };
    }
  }

  // --- OKX 备用：funding-rate + open-interest ---
  const swapInst = `${okxId}-SWAP`;
  const [okxFunding, okxOi] = await Promise.all([
    fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${swapInst}`),
    fetchJson(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${swapInst}`),
  ]);

  let rate: number | null = null;
  let oiUsd: number | null = null;
  if (okxFunding?.code === '0' && Array.isArray(okxFunding.data) && okxFunding.data.length > 0) {
    const r = parseFloat(okxFunding.data[0].fundingRate);
    if (Number.isFinite(r)) rate = r;
  }
  if (okxOi?.code === '0' && Array.isArray(okxOi.data) && okxOi.data.length > 0) {
    // 新版接口有 oiUsd 字段；旧版只有 oi(张)/oiCcy(币)，需配合价格折算，取不到就置空
    if (okxOi.data[0].oiUsd != null) {
      const v = parseFloat(okxOi.data[0].oiUsd);
      if (Number.isFinite(v) && v > 0) oiUsd = v;
    }
  }
  return {
    fundingRate8h: rate,
    openInterestUsd: oiUsd,
    longShortAccountRatio: null, // OKX 备用路径无对应接口
    takerLongShortRatio: null,
    oiChange24hPct: null,
  };
}

/** 计算持仓量 1 小时变化（基于内存快照，冷启动后需积累约 1 小时） */
function computeOiChange(symbol: string, oiUsd: number | null): number | null {
  if (oiUsd == null || oiUsd <= 0) return null;
  const now = Date.now();
  const arr = oiHistory.get(symbol) || [];

  // 追加当前快照（同 5 分钟窗口内不重复追加）
  if (arr.length === 0 || now - arr[arr.length - 1].t > 4 * 60_000) {
    arr.push({ t: now, oi: oiUsd });
  }
  // 只保留 2 小时
  while (arr.length > 0 && now - arr[0].t > 2 * 60 * 60_000) arr.shift();
  oiHistory.set(symbol, arr);

  // 找 55 分钟以前、最早的快照做对比基准
  const ref = arr.find((s) => now - s.t >= 55 * 60_000);
  if (!ref || ref.oi <= 0) return null; // 积累不足
  return Number(((oiUsd - ref.oi) / ref.oi * 100).toFixed(2));
}

async function getDerivatives(symbol: string, okxId: string): Promise<DerivData & { oiChange1hPct: number | null }> {
  const cached = derivCache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.at < DERIV_TTL_MS && cached.data.openInterestUsd != null) {
    // 命中缓存也要推进快照历史（便宜，纯内存）
    return { ...cached.data, oiChange1hPct: computeOiChange(symbol, cached.data.openInterestUsd) };
  }

  const data = await fetchFundingAndOI(symbol, okxId);
  derivCache.set(symbol, { data, at: now });
  return { ...data, oiChange1hPct: computeOiChange(symbol, data.openInterestUsd) };
}

// ==================== 恐惧贪婪指数 ====================

async function getFearGreed(): Promise<MarketContext['fearGreed']> {
  if (fearCache.data && Date.now() - fearCache.at < FEAR_TTL_MS) return fearCache.data;
  const json = await fetchJson('https://api.alternative.me/fng/?limit=1');
  let result: MarketContext['fearGreed'] = null;
  const entry = json?.data?.[0];
  if (entry && entry.value != null) {
    const value = parseInt(entry.value, 10);
    if (Number.isFinite(value)) {
      result = { value, classification: String(entry.value_classification || '') };
    }
  }
  if (result) fearCache.data = result, fearCache.at = Date.now();
  return result;
}

// ==================== 新闻要闻（Cointelegraph RSS） ====================

const NEWS_WINDOW_MS = 3 * 60 * 60_000; // 只取 3 小时内的要闻

/**
 * 新闻相关性打分：只保留能真正影响短线行情的硬新闻
 * 快讯流里 2/3 是噪音（分红/汽油/番茄类），噪音会稀释 AI 判断
 */
function scoreNewsRelevance(title: string): number {
  const t = title.toLowerCase();
  // 一级关键词（监管/安全/宏观事件，直接驱动价格）：+3
  const critical = ['hack', 'hacked', 'exploit', 'breach', 'sec ', 'lawsuit', 'sue', 'ban', 'bans',
    'etf', 'fed ', 'fomc', 'cpi', 'rate cut', 'rate hike', 'interest rate', 'treasury',
    'liquidat', 'crash', 'plunge', 'surge', 'flash', 'insolvency', 'bankrupt', 'arrest'];
  // 二级关键词（资金流/机构动向）：+2
  const important = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol',
    'inflow', 'outflow', 'whale', 'etfs', 'approval', 'approve', 'record',
    'treasury', 'microstrategy', 'binance', 'coinbase', 'stablecoin', 'tether'];
  // 噪音关键词（与加密行情无关的填充内容）：直接判 0
  const noise = ['tomato', 'gasoline', 'diesel', 'onlyfans', 'dividend', 'miss universe',
    'football', 'soccer', 'celebrit', 'movie', 'music', 'fashion'];

  if (noise.some((k) => t.includes(k))) return 0;
  let score = 0;
  if (critical.some((k) => t.includes(k))) score += 3;
  if (important.some((k) => t.includes(k))) score += 2;
  // 含具体金额（$XXM/B）的加 1（大额事件）
  if (/\$\d+(\.\d+)?\s*[mb]/.test(t)) score += 1;
  return score;
}

async function getNews(): Promise<NewsItem[]> {
  if (newsCache.data && Date.now() - newsCache.at < NEWS_TTL_MS) return newsCache.data;

  const xml = await fetchText('https://cointelegraph.com/rss');
  if (!xml) return newsCache.data || [];

  const items: NewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < 40) {
    const block = m[1];
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
    const dateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    if (!titleMatch) continue;

    // 标题：去 CDATA 包裹和残留标签
    let title = titleMatch[1].trim();
    title = title.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
    title = title.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (!title) continue;

    const ts = dateMatch ? Date.parse(dateMatch[1].trim()) : NaN;
    items.push({
      title,
      publishedAt: Number.isFinite(ts) ? ts : 0,
      source: 'Cointelegraph',
    });
  }

  // 3 小时内 → 相关性打分 → 只保留得分 >= 2 的硬新闻（监管/安全/资金流），最多 5 条
  const now = Date.now();
  const fresh = items
    .filter((i) => i.publishedAt > 0 && now - i.publishedAt <= NEWS_WINDOW_MS)
    .map((i) => ({ ...i, score: scoreNewsRelevance(i.title) }))
    .filter((i) => i.score >= 2)
    .sort((a, b) => b.score - a.score || b.publishedAt - a.publishedAt)
    .slice(0, 5)
    .map(({ score: _s, ...rest }) => rest as NewsItem);

  if (fresh.length > 0) newsCache.data = fresh, newsCache.at = Date.now();
  return fresh;
}

// ==================== 汇总入口 ====================

export async function fetchMarketContext(symbol: string, okxId: string): Promise<MarketContext> {
  const [deriv, fearGreed, news] = await Promise.all([
    getDerivatives(symbol, okxId),
    getFearGreed().catch(() => null),
    getNews().catch(() => [] as NewsItem[]),
  ]);

  return {
    fundingRate8h: deriv.fundingRate8h,
    openInterestUsd: deriv.openInterestUsd,
    oiChange1hPct: deriv.oiChange1hPct,
    oiChange24hPct: deriv.oiChange24hPct,
    longShortAccountRatio: deriv.longShortAccountRatio,
    takerLongShortRatio: deriv.takerLongShortRatio,
    fearGreed,
    news,
  };
}

// ==================== BTC 联动快照（山寨币分析必看 BTC） ====================

export interface BtcSnapshot {
  price: number;
  /** 近 1 小时涨跌幅 % */
  change1hPct: number | null;
  /** 15m 趋势: up / down / flat */
  trend15m: 'up' | 'down' | 'flat';
  /** BTC 资金费率 */
  fundingRate8h: number | null;
  /** BTC 是否处于高波动状态（1h 涨跌绝对值 >= 2%） */
  highVolatility: boolean;
}

const btcCache = { data: null as BtcSnapshot | null, at: 0 };
const BTC_TTL_MS = 3 * 60_000;

async function fetchBtcKlineTrend(): Promise<{ trend15m: 'up' | 'down' | 'flat'; change1hPct: number | null; price: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=12', {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { trend15m: 'flat', change1hPct: null, price: null };
    const rows: any[] = await res.json();
    if (!Array.isArray(rows) || rows.length < 5) return { trend15m: 'flat', change1hPct: null, price: null };

    const closes = rows.map((r) => parseFloat(r[4]));
    const price = closes[closes.length - 1];

    // 15m 趋势：最近 6 根 EMA 简化判断（后 3 根均价 vs 前 3 根均价）
    const recentAvg = closes.slice(-3).reduce((s: number, c: number) => s + c, 0) / 3;
    const priorAvg = closes.slice(-6, -3).reduce((s: number, c: number) => s + c, 0) / 3;
    const diffPct = priorAvg > 0 ? ((recentAvg - priorAvg) / priorAvg) * 100 : 0;
    const trend15m: 'up' | 'down' | 'flat' = diffPct > 0.15 ? 'up' : diffPct < -0.15 ? 'down' : 'flat';

    // 1h 涨跌：当前价 vs 4 根 15m 前（约 1 小时）
    let change1hPct: number | null = null;
    if (closes.length >= 5) {
      const ref = closes[closes.length - 5];
      if (ref > 0) change1hPct = Number((((price - ref) / ref) * 100).toFixed(2));
    }

    return { trend15m, change1hPct, price };
  } catch {
    return { trend15m: 'flat', change1hPct: null, price: null };
  } finally {
    clearTimeout(timer);
  }
}

/** 获取 BTC 快照（3 分钟缓存）；失败返回 null，prompt 侧优雅降级 */
export async function fetchBtcSnapshot(): Promise<BtcSnapshot | null> {
  if (btcCache.data && Date.now() - btcCache.at < BTC_TTL_MS) return btcCache.data;

  const [kline, deriv] = await Promise.all([
    fetchBtcKlineTrend(),
    getDerivatives('BTCUSDT', 'BTC-USDT'),
  ]);

  if (kline.price == null) return btcCache.data; // 完全失败时用旧缓存或 null

  const snap: BtcSnapshot = {
    price: kline.price,
    change1hPct: kline.change1hPct,
    trend15m: kline.trend15m,
    fundingRate8h: deriv.fundingRate8h,
    highVolatility: kline.change1hPct != null && Math.abs(kline.change1hPct) >= 2,
  };
  btcCache.data = snap;
  btcCache.at = Date.now();
  return snap;
}

/** BTC 快照注入 prompt 的文本（null 时返回空字符串） */
export function buildBtcContextText(btc: BtcSnapshot | null): string {
  if (!btc) return '';
  const trendZh = btc.trend15m === 'up' ? '上涨' : btc.trend15m === 'down' ? '下跌' : '横盘';
  const chg = btc.change1hPct != null ? `${btc.change1hPct > 0 ? '+' : ''}${btc.change1hPct}%` : '暂无数据';
  const fr = btc.fundingRate8h != null ? `${(btc.fundingRate8h * 100).toFixed(4)}%` : '暂无数据';
  const volWarn = btc.highVolatility
    ? `\n⚠️ BTC 1小时波动 ${chg}，处于高波动状态：山寨币信号可靠性大幅下降，除非自身逻辑极强，否则应给 neutral 或大幅降低置信度`
    : '';
  return `=== BTC 联动背景（山寨币方向的先行指标） ===
BTC 价格: ${btc.price} | 15分钟趋势: ${trendZh} | 1小时涨跌: ${chg} | 资金费率: ${fr}${volWarn}
解读规则: BTC 急跌时山寨做多信号多为假信号；BTC 高波动时段山寨技术形态容易瞬间失效；与 BTC 趋势同向的山寨信号更可靠`;
}

// ==================== Prompt 文本构建 ====================

/** 恐惧贪婪英文分类 → 中文 */
const FNG_ZH: Record<string, string> = {
  'Extreme Fear': '极度恐惧',
  Fear: '恐惧',
  Neutral: '中性',
  Greed: '贪婪',
  'Extreme Greed': '极度贪婪',
};

/** 生成注入 prompt 的市场上下文文本块 */
export function buildMarketContextText(ctx: MarketContext): string {
  const lines: string[] = [];

  // 资金费率 + 拥挤度解读
  if (ctx.fundingRate8h != null) {
    const pct = ctx.fundingRate8h * 100; // 0.00047 → 0.047%
    const annualized = ctx.fundingRate8h * 3 * 365 * 100;
    let tone: string;
    if (pct >= 0.05) tone = '多头严重拥挤，反抽/回调风险高';
    else if (pct >= 0.015) tone = '多头偏拥挤';
    else if (pct <= -0.05) tone = '空头严重拥挤，轧空风险高';
    else if (pct <= -0.015) tone = '空头偏拥挤';
    else tone = '多空均衡';
    lines.push(`资金费率(8h): ${pct.toFixed(4)}%（年化约 ${annualized.toFixed(0)}%，${tone}）`);
  } else {
    lines.push('资金费率: 暂无数据');
  }

  // 持仓量 + 1 小时变化
  if (ctx.openInterestUsd != null) {
    const oiText = ctx.openInterestUsd >= 1e9
      ? `$${(ctx.openInterestUsd / 1e9).toFixed(2)}B`
      : `$${(ctx.openInterestUsd / 1e6).toFixed(1)}M`;
    const changeText = ctx.oiChange1hPct != null
      ? `${ctx.oiChange1hPct > 0 ? '+' : ''}${ctx.oiChange1hPct}%`
      : '数据积累中';
    const change24hText = ctx.oiChange24hPct != null
      ? `，24小时 ${ctx.oiChange24hPct > 0 ? '+' : ''}${ctx.oiChange24hPct}%`
      : '';
    lines.push(`持仓量: ${oiText}（1小时 ${changeText}${change24hText}）`);
    // 量价背离提示（价涨仓减 = 上涨缺乏新增杠杆，获利了结迹象）
    if (ctx.oiChange24hPct != null) {
      const chg24 = ctx.oiChange24hPct < -1 ? ' ⚠️ 价涨仓减，趋势健康度存疑'
        : ctx.oiChange24hPct > 3 ? ' ⚠️ 仓增过快，拥挤度上升' : '';
      if (change24hText && chg24) lines[lines.length - 1] += chg24;
    }
  } else {
    lines.push('持仓量: 暂无数据');
  }

  // 多空比（散户情绪反向指标：极端拥挤的一端常是被收割的一端）
  if (ctx.longShortAccountRatio != null || ctx.takerLongShortRatio != null) {
    const accText = ctx.longShortAccountRatio != null
      ? ctx.longShortAccountRatio.toFixed(2)
      : '暂无';
    const takerText = ctx.takerLongShortRatio != null
      ? ctx.takerLongShortRatio.toFixed(2)
      : '暂无';
    // 拥挤度解读（账户口径）：>2 多头极度拥挤（追多危险），<0.5 空头极度拥挤（追空危险）
    let lsTone = '多空均衡';
    if (ctx.longShortAccountRatio != null) {
      if (ctx.longShortAccountRatio >= 2) lsTone = '散户多头极度拥挤，追多谨慎';
      else if (ctx.longShortAccountRatio >= 1.4) lsTone = '散户偏多';
      else if (ctx.longShortAccountRatio <= 0.5) lsTone = '散户空头极度拥挤，追空谨慎';
      else if (ctx.longShortAccountRatio <= 0.7) lsTone = '散户偏空';
    }
    lines.push(`多空比(账户/主动买卖): ${accText} / ${takerText}（${lsTone}）`);
  }

  // 恐惧贪婪
  if (ctx.fearGreed) {
    const zh = FNG_ZH[ctx.fearGreed.classification] || ctx.fearGreed.classification;
    lines.push(`恐惧贪婪指数: ${ctx.fearGreed.value}/100（${zh}）`);
  } else {
    lines.push('恐惧贪婪指数: 暂无数据');
  }

  // 要闻
  if (ctx.news.length > 0) {
    lines.push(`近${Math.round(NEWS_WINDOW_MS / 3600000)}小时要闻:`);
    ctx.news.forEach((n, i) => {
      const t = new Date(n.publishedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      lines.push(`${i + 1}. [${n.source} ${t}UTC] ${n.title}`);
    });
  } else {
    lines.push('近3小时无重大要闻');
  }

  lines.push('解读要点: 费率极端正=多头拥挤；突破伴随持仓量增加=可信，缩量突破=疑似陷阱；突发新闻（黑客/监管/清算）权重高于技术形态');

  return `=== 衍生品与市场情绪（真实市场数据） ===\n${lines.join('\n')}`;
}
