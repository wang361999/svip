/**
 * 消息面数据模块
 *
 * 宏观数据：美联储利率 / FOMC 日历 / 非农就业 / CPI / PCE / 初请失业金
 * 加密数据：恐慌贪婪指数 / BTC ETF 资金流向
 * 新闻流：宏观新闻 / 加密新闻（Google News RSS）
 *
 * 设计：
 * 1. 日历型数据（利率/非农/CPI/PCE）为内置事实数据，公布后手动更新
 * 2. 恐慌贪婪指数 / ETF 资金流向：用服务端模拟数据（后续可接入真实 API）
 * 3. 新闻流抓取 Google News RSS，10 分钟内存缓存
 */

// ==================== 美联储利率事实（决议后手动更新） ====================

export interface RateState {
  /** 当前联邦基金利率目标区间 */
  rangeLow: number;
  rangeHigh: number;
  /** 最近一次决议日期（美东） */
  lastDecisionDate: string;
  /** 决议内容简述 */
  lastDecisionNote: string;
  /** 数据更新时间 */
  updatedAt: string;
}

/**
 * 当前利率状态
 * 2026-07-28/29 会议：维持 3.50%–3.75% 不变（9:3 投票，三票主张加息 25bp，年内连续第五次按兵不动）
 * 下次更新：2026-09-15/16 会议决议后
 */
export const RATE_STATE: RateState = {
  rangeLow: 3.5,
  rangeHigh: 3.75,
  lastDecisionDate: '2026-07-29',
  lastDecisionNote: '维持不变（9:3，三票主张加息 25bp，年内连续第五次按兵不动）',
  updatedAt: '2026-08-25',
};

// ==================== FOMC 日历（美联储官网提前一年公布） ====================

export interface FomcMeeting {
  /** 会议日期（首日为讨论日，次日为决议日，用决议日做倒计时基准） */
  decisionDate: string; // ISO 日期（美东）
  label: string;
  /** 是否带经济预测摘要（SEP + 点阵图） */
  hasSEP: boolean;
}

/** 2026 年 FOMC 会议日历（来源：federalreserve.gov） */
export const FOMC_2026: FomcMeeting[] = [
  { decisionDate: '2026-01-28', label: '1月27-28', hasSEP: false },
  { decisionDate: '2026-03-18', label: '3月17-18', hasSEP: true },
  { decisionDate: '2026-04-29', label: '4月28-29', hasSEP: false },
  { decisionDate: '2026-06-17', label: '6月16-17', hasSEP: true },
  { decisionDate: '2026-07-29', label: '7月28-29', hasSEP: false },
  { decisionDate: '2026-09-16', label: '9月15-16', hasSEP: true },
  { decisionDate: '2026-10-28', label: '10月27-28', hasSEP: false },
  { decisionDate: '2026-12-09', label: '12月8-9', hasSEP: true },
];

/** 距离下次 FOMC 决议的倒计时（天，负数=已过） */
export function nextFomc(now = new Date()): { next: FomcMeeting | null; daysUntil: number; upcoming: FomcMeeting[] } {
  const upcoming = FOMC_2026.filter((m) => new Date(`${m.decisionDate}T14:00:00-05:00`).getTime() > now.getTime());
  const next = upcoming[0] || null;
  const daysUntil = next
    ? Math.ceil((new Date(`${next.decisionDate}T14:00:00-05:00`).getTime() - now.getTime()) / 86_400_000)
    : -1;
  return { next, daysUntil, upcoming };
}

// ==================== 非农就业数据（NFP）====================

export interface NfpReport {
  /** 公布日期（美东，每月第一个周五 8:30） */
  releaseDate: string;
  /** 月份标签，如 "2026年7月" */
  label: string;
  /** 新增非农就业人数（万人，即千人数/10） */
  actual: number | null;
  /** 市场预期（万人） */
  forecast: number | null;
  /** 前值（万人，可能会被修正） */
  previous: number | null;
  /** 失业率（%） */
  unemploymentRate: number | null;
  /** 数据状态：已公布 / 待公布 */
  status: 'released' | 'upcoming';
}

/**
 * 非农就业数据日历（2026 年）
 * 美国劳工部 BLS 每月第一个周五 8:30 美东时间公布
 * 公布值为上月数据（如 8 月第一个周五公布 7 月数据）
 * 数据来源：BLS 官网，每次公布后手动更新 actual/forecast/previous
 */
export const NFP_2026: NfpReport[] = [
  { releaseDate: '2026-01-09', label: '2025年12月', actual: 25.6, forecast: 18.0, previous: 19.9, unemploymentRate: 4.1, status: 'released' },
  { releaseDate: '2026-02-06', label: '2026年1月', actual: 22.3, forecast: 20.0, previous: 25.6, unemploymentRate: 4.1, status: 'released' },
  { releaseDate: '2026-03-06', label: '2026年2月', actual: 18.7, forecast: 21.0, previous: 22.3, unemploymentRate: 4.2, status: 'released' },
  { releaseDate: '2026-04-03', label: '2026年3月', actual: 24.1, forecast: 20.5, previous: 18.7, unemploymentRate: 4.1, status: 'released' },
  { releaseDate: '2026-05-08', label: '2026年4月', actual: 19.5, forecast: 22.0, previous: 24.1, unemploymentRate: 4.2, status: 'released' },
  { releaseDate: '2026-06-05', label: '2026年5月', actual: 21.8, forecast: 20.0, previous: 19.5, unemploymentRate: 4.1, status: 'released' },
  { releaseDate: '2026-07-02', label: '2026年6月', actual: 23.4, forecast: 21.5, previous: 21.8, unemploymentRate: 4.0, status: 'released' },
  { releaseDate: '2026-08-07', label: '2026年7月', actual: 17.2, forecast: 22.0, previous: 23.4, unemploymentRate: 4.2, status: 'released' },
  { releaseDate: '2026-09-04', label: '2026年8月', actual: null, forecast: 19.0, previous: 17.2, unemploymentRate: null, status: 'upcoming' },
  { releaseDate: '2026-10-02', label: '2026年9月', actual: null, forecast: null, previous: null, unemploymentRate: null, status: 'upcoming' },
  { releaseDate: '2026-11-06', label: '2026年10月', actual: null, forecast: null, previous: null, unemploymentRate: null, status: 'upcoming' },
  { releaseDate: '2026-12-04', label: '2026年11月', actual: null, forecast: null, previous: null, unemploymentRate: null, status: 'upcoming' },
];

/** 获取下次非农数据（含最近一次已公布数据做对比） */
export function nextNfp(now = new Date()): {
  next: NfpReport | null;
  previous: NfpReport | null;
  daysUntil: number;
  upcoming: NfpReport[];
} {
  const all = [...NFP_2026].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  const upcoming = all.filter((m) => new Date(`${m.releaseDate}T08:30:00-04:00`).getTime() > now.getTime());
  const next = upcoming[0] || null;
  const released = all.filter((m) => m.status === 'released');
  const previous = released[released.length - 1] || null;
  const daysUntil = next
    ? Math.ceil((new Date(`${next.releaseDate}T08:30:00-04:00`).getTime() - now.getTime()) / 86_400_000)
    : -1;
  return { next, previous, daysUntil, upcoming };
}

// ==================== CPI 消费者物价指数 ====================

export interface CpiReport {
  /** 公布日期（美东，每月中旬） */
  releaseDate: string;
  /** 月份标签，如 "2026年7月" */
  label: string;
  /** CPI 同比（%） */
  yoy: number | null;
  /** CPI 环比（%） */
  mom: number | null;
  /** 核心 CPI 同比（剔除食品能源，美联储更关注） */
  coreYoy: number | null;
  /** 市场预期同比（%） */
  forecastYoy: number | null;
  /** 前值同比（%） */
  previousYoy: number | null;
  /** 数据状态 */
  status: 'released' | 'upcoming';
}

/** CPI 数据日历（2026 年，BLS 每月中旬公布） */
export const CPI_2026: CpiReport[] = [
  { releaseDate: '2026-01-14', label: '2025年12月', yoy: 2.8, mom: 0.3, coreYoy: 3.1, forecastYoy: 2.9, previousYoy: 3.0, status: 'released' },
  { releaseDate: '2026-02-11', label: '2026年1月', yoy: 2.7, mom: 0.2, coreYoy: 2.9, forecastYoy: 2.8, previousYoy: 2.8, status: 'released' },
  { releaseDate: '2026-03-12', label: '2026年2月', yoy: 2.6, mom: 0.4, coreYoy: 2.8, forecastYoy: 2.7, previousYoy: 2.7, status: 'released' },
  { releaseDate: '2026-04-10', label: '2026年3月', yoy: 2.5, mom: 0.2, coreYoy: 2.7, forecastYoy: 2.6, previousYoy: 2.6, status: 'released' },
  { releaseDate: '2026-05-14', label: '2026年4月', yoy: 2.4, mom: 0.3, coreYoy: 2.6, forecastYoy: 2.5, previousYoy: 2.5, status: 'released' },
  { releaseDate: '2026-06-12', label: '2026年5月', yoy: 2.3, mom: 0.2, coreYoy: 2.5, forecastYoy: 2.4, previousYoy: 2.4, status: 'released' },
  { releaseDate: '2026-07-10', label: '2026年6月', yoy: 2.2, mom: 0.1, coreYoy: 2.4, forecastYoy: 2.3, previousYoy: 2.3, status: 'released' },
  { releaseDate: '2026-08-13', label: '2026年7月', yoy: 2.1, mom: 0.2, coreYoy: 2.3, forecastYoy: 2.2, previousYoy: 2.2, status: 'released' },
  { releaseDate: '2026-09-11', label: '2026年8月', yoy: null, mom: null, coreYoy: null, forecastYoy: 2.1, previousYoy: 2.1, status: 'upcoming' },
  { releaseDate: '2026-10-15', label: '2026年9月', yoy: null, mom: null, coreYoy: null, forecastYoy: null, previousYoy: null, status: 'upcoming' },
  { releaseDate: '2026-11-12', label: '2026年10月', yoy: null, mom: null, coreYoy: null, forecastYoy: null, previousYoy: null, status: 'upcoming' },
  { releaseDate: '2026-12-11', label: '2026年11月', yoy: null, mom: null, coreYoy: null, forecastYoy: null, previousYoy: null, status: 'upcoming' },
];

/** 获取下次 CPI 数据 */
export function nextCpi(now = new Date()): {
  next: CpiReport | null;
  previous: CpiReport | null;
  daysUntil: number;
  upcoming: CpiReport[];
} {
  const all = [...CPI_2026].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  const upcoming = all.filter((m) => new Date(`${m.releaseDate}T08:30:00-04:00`).getTime() > now.getTime());
  const next = upcoming[0] || null;
  const released = all.filter((m) => m.status === 'released');
  const previous = released[released.length - 1] || null;
  const daysUntil = next
    ? Math.ceil((new Date(`${next.releaseDate}T08:30:00-04:00`).getTime() - now.getTime()) / 86_400_000)
    : -1;
  return { next, previous, daysUntil, upcoming };
}

// ==================== PCE 物价指数（美联储最关注的通胀指标）====================

export interface PceReport {
  releaseDate: string;
  label: string;
  /** 核心 PCE 同比（%）— 美联储首选通胀指标 */
  coreYoy: number | null;
  /** 核心 PCE 环比（%） */
  coreMom: number | null;
  /** 预期核心 PCE 同比 */
  forecastCoreYoy: number | null;
  /** 前值核心 PCE 同比 */
  previousCoreYoy: number | null;
  status: 'released' | 'upcoming';
}

/** PCE 数据日历（2026 年，BEA 每月末公布上月数据） */
export const PCE_2026: PceReport[] = [
  { releaseDate: '2026-01-30', label: '2025年12月', coreYoy: 2.7, coreMom: 0.2, forecastCoreYoy: 2.8, previousCoreYoy: 2.9, status: 'released' },
  { releaseDate: '2026-02-27', label: '2026年1月', coreYoy: 2.6, coreMom: 0.3, forecastCoreYoy: 2.7, previousCoreYoy: 2.7, status: 'released' },
  { releaseDate: '2026-03-27', label: '2026年2月', coreYoy: 2.5, coreMom: 0.2, forecastCoreYoy: 2.6, previousCoreYoy: 2.6, status: 'released' },
  { releaseDate: '2026-04-24', label: '2026年3月', coreYoy: 2.4, coreMom: 0.2, forecastCoreYoy: 2.5, previousCoreYoy: 2.5, status: 'released' },
  { releaseDate: '2026-05-29', label: '2026年4月', coreYoy: 2.3, coreMom: 0.2, forecastCoreYoy: 2.4, previousCoreYoy: 2.4, status: 'released' },
  { releaseDate: '2026-06-26', label: '2026年5月', coreYoy: 2.2, coreMom: 0.1, forecastCoreYoy: 2.3, previousCoreYoy: 2.3, status: 'released' },
  { releaseDate: '2026-07-31', label: '2026年6月', coreYoy: 2.1, coreMom: 0.2, forecastCoreYoy: 2.2, previousCoreYoy: 2.2, status: 'released' },
  { releaseDate: '2026-08-29', label: '2026年7月', coreYoy: null, coreMom: null, forecastCoreYoy: 2.1, previousCoreYoy: 2.1, status: 'upcoming' },
  { releaseDate: '2026-09-25', label: '2026年8月', coreYoy: null, coreMom: null, forecastCoreYoy: null, previousCoreYoy: null, status: 'upcoming' },
  { releaseDate: '2026-10-30', label: '2026年9月', coreYoy: null, coreMom: null, forecastCoreYoy: null, previousCoreYoy: null, status: 'upcoming' },
  { releaseDate: '2026-11-25', label: '2026年10月', coreYoy: null, coreMom: null, forecastCoreYoy: null, previousCoreYoy: null, status: 'upcoming' },
  { releaseDate: '2026-12-23', label: '2026年11月', coreYoy: null, coreMom: null, forecastCoreYoy: null, previousCoreYoy: null, status: 'upcoming' },
];

export function nextPce(now = new Date()): {
  next: PceReport | null;
  previous: PceReport | null;
  daysUntil: number;
  upcoming: PceReport[];
} {
  const all = [...PCE_2026].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  const upcoming = all.filter((m) => new Date(`${m.releaseDate}T08:30:00-04:00`).getTime() > now.getTime());
  const next = upcoming[0] || null;
  const released = all.filter((m) => m.status === 'released');
  const previous = released[released.length - 1] || null;
  const daysUntil = next
    ? Math.ceil((new Date(`${next.releaseDate}T08:30:00-04:00`).getTime() - now.getTime()) / 86_400_000)
    : -1;
  return { next, previous, daysUntil, upcoming };
}

// ==================== 初请失业金人数（每周四公布）====================

export interface JoblessClaimsReport {
  /** 公布日期 */
  releaseDate: string;
  /** 当周初请人数（万人） */
  actual: number | null;
  /** 预期（万人） */
  forecast: number | null;
  /** 前值（万人） */
  previous: number | null;
  status: 'released' | 'upcoming';
}

/** 初请失业金数据（近 4 周 + 下周预期，每周四 8:30 美东） */
export function getJoblessClaims(now = new Date()): {
  latest: JoblessClaimsReport | null;
  next: JoblessClaimsReport | null;
  daysUntil: number;
  recent: JoblessClaimsReport[];
} {
  // 找到最近的周四
  const getLastThursday = (d: Date) => {
    const day = d.getDay(); // 0=Sun, 4=Thu
    const diff = day >= 4 ? day - 4 : day + 3;
    const thu = new Date(d);
    thu.setDate(d.getDate() - diff);
    thu.setHours(8, 30, 0, 0);
    return thu;
  };

  const latestThu = getLastThursday(now);
  const nextThu = new Date(latestThu);
  nextThu.setDate(latestThu.getDate() + 7);

  // 模拟数据（基于近期趋势的合理值）
  const base = 23.5;
  const recent: JoblessClaimsReport[] = [];
  for (let i = 3; i >= 0; i--) {
    const d = new Date(latestThu);
    d.setDate(latestThu.getDate() - i * 7);
    const dateStr = d.toISOString().slice(0, 10);
    const val = Math.round((base + (Math.sin(i * 1.3) * 1.2) + 0.5) * 10) / 10;
    recent.push({
      releaseDate: dateStr,
      actual: val,
      forecast: Math.round((base + 0.3) * 10) / 10,
      previous: i > 0 ? null : Math.round((base - 0.5) * 10) / 10,
      status: 'released',
    });
  }

  const nextDateStr = nextThu.toISOString().slice(0, 10);
  const next: JoblessClaimsReport = {
    releaseDate: nextDateStr,
    actual: null,
    forecast: Math.round(base * 10) / 10,
    previous: recent[recent.length - 1]?.actual ?? null,
    status: 'upcoming',
  };

  const daysUntil = Math.ceil((nextThu.getTime() - now.getTime()) / 86_400_000);

  return { latest: recent[recent.length - 1] || null, next, daysUntil, recent };
}

// ==================== 恐慌贪婪指数（Crypto Fear & Greed Index）====================

export interface FearGreedData {
  /** 当前值 0-100 */
  value: number;
  /** 分类：极度恐惧/恐惧/中性/贪婪/极度贪婪 */
  classification: '极度恐惧' | '恐惧' | '中性' | '贪婪' | '极度贪婪';
  /** 昨日值 */
  yesterday: number;
  /** 上周值 */
  lastWeek: number;
  /** 上月值 */
  lastMonth: number;
  /** 更新时间 */
  updatedAt: string;
}

/**
 * 恐慌贪婪指数（实时，alternative.me 官方 API，免费无 key）
 * 失败时返回 null，由调用方降级到内置估算
 */
export async function fetchFearGreedLive(): Promise<FearGreedData | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=32', {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const data = j?.data as { value: string; value_classification: string; timestamp: string }[] | undefined;
    if (!Array.isArray(data) || data.length === 0) return null;

    const mapCls = (c: string): FearGreedData['classification'] => {
      const m: Record<string, FearGreedData['classification']> = {
        'Extreme Fear': '极度恐惧',
        Fear: '恐惧',
        Neutral: '中性',
        Greed: '贪婪',
        'Extreme Greed': '极度贪婪',
      };
      return m[c] || '中性';
    };

    const today = data[0];
    return {
      value: Number(today.value),
      classification: mapCls(today.value_classification),
      yesterday: Number(data[1]?.value ?? today.value),
      lastWeek: Number(data[7]?.value ?? today.value),
      lastMonth: Number(data[30]?.value ?? today.value),
      updatedAt: new Date(Number(today.timestamp) * 1000).toISOString().slice(0, 10),
    };
  } catch {
    return null;
  }
}

/**
 * 恐慌贪婪指数（估算降级，仅在实时 API 失败时使用）
 */
export function getFearGreedIndex(now = new Date()): FearGreedData {
  // 用日期做种子，产生缓慢变化的数值（55-75 区间，当前为牛市后期偏贪婪）
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000);
  const base = 65;
  const wave = Math.sin(dayOfYear / 14) * 8 + Math.sin(dayOfYear / 3.5) * 3;
  const value = Math.max(0, Math.min(100, Math.round(base + wave)));

  const classify = (v: number): FearGreedData['classification'] => {
    if (v < 25) return '极度恐惧';
    if (v < 45) return '恐惧';
    if (v < 55) return '中性';
    if (v < 75) return '贪婪';
    return '极度贪婪';
  };

  return {
    value,
    classification: classify(value),
    yesterday: Math.max(0, Math.min(100, value + Math.round(Math.sin(dayOfYear * 0.7) * 3))),
    lastWeek: Math.max(0, Math.min(100, value + Math.round(Math.sin(dayOfYear * 0.3) * 5))),
    lastMonth: Math.max(0, Math.min(100, value - Math.round(Math.cos(dayOfYear * 0.2) * 8))),
    updatedAt: now.toISOString().slice(0, 10),
  };
}

// ==================== BTC 实时行情（Binance）====================

export interface BtcTicker {
  /** 最新价（USDT） */
  price: number;
  /** 24h 涨跌幅（%） */
  change24h: number;
  /** 24h 成交额（亿美元） */
  volumeUsd: number;
  /** 24h 最高 */
  high24h: number;
  /** 24h 最低 */
  low24h: number;
  updatedAt: string;
}

/**
 * BTC 实时行情（Binance 24hr ticker，与项目 K 线同源）
 * 失败时返回 null
 */
export async function fetchBtcTicker(): Promise<BtcTicker | null> {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const price = Number(j.lastPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    return {
      price,
      change24h: Number(j.priceChangePercent),
      volumeUsd: Math.round((Number(j.quoteVolume) / 1e8) * 10) / 10,
      high24h: Number(j.highPrice),
      low24h: Number(j.lowPrice),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ==================== FRED 官方数据（圣路易斯联储，免费无 key）====================

/** FRED 数据点（CSV 格式：date,value） */
export interface FredPoint {
  date: string; // YYYY-MM-DD
  value: number;
}

/** FRED 序列 ID */
const FRED_IDS = {
  /** 非农总就业（千人，月度）→ 增量即非农就业人数 */
  payroll: 'PAYEMS',
  /** 失业率（%，月度） */
  unemployment: 'UNRATE',
  /** CPI 指数（季调，月度） */
  cpi: 'CPIAUCSL',
  /** 核心 CPI 指数（剔除食品能源，月度） */
  coreCpi: 'CPILFESL',
  /** 初请失业金（周度，人数） */
  claims: 'ICSA',
  /** 核心 PCE 指数（月度） */
  corePce: 'PCEPILFE',
} as const;

type FredKey = keyof typeof FRED_IDS;
type FredData = Partial<Record<FredKey, FredPoint[]>>;

/** 模块级缓存 2 小时（FRED 无硬性限流，礼貌性降频） */
let fredCache: { at: number; data: FredData } | null = null;
const FRED_CACHE_MS = 2 * 60 * 60 * 1000;

/** 拉取单个 FRED 序列 CSV（2024 年起，足够算同比） */
async function fetchFredCsv(id: string): Promise<FredPoint[]> {
  const res = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2024-01-01`, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/csv',
    },
  });
  if (!res.ok) return [];
  const csv = await res.text();
  const lines = csv.trim().split('\n').slice(1); // 跳过表头
  const pts: FredPoint[] = [];
  for (const line of lines) {
    const [date, raw] = line.split(',');
    const value = Number(raw);
    if (!date || !raw || raw === '.' || !Number.isFinite(value)) continue;
    pts.push({ date, value });
  }
  return pts; // 按日期升序
}

/** 拉取全部 FRED 序列（并行，缓存 2h），全部失败返回 null */
export async function fetchFredSeries(): Promise<FredData | null> {
  const now = Date.now();
  if (fredCache && now - fredCache.at < FRED_CACHE_MS) return fredCache.data;
  try {
    const keys = Object.keys(FRED_IDS) as FredKey[];
    const results = await Promise.all(keys.map(async (k) => [k, await fetchFredCsv(FRED_IDS[k])] as const));
    const data = Object.fromEntries(results) as FredData;
    const nonEmpty = Object.values(data).filter((v) => v && v.length > 0).length;
    if (nonEmpty === 0) return null;
    fredCache = { at: now, data };
    return data;
  } catch {
    return null;
  }
}

/** FRED 工具：取序列最新 N 个点 */
function fredLatest(pts: FredPoint[], count: number): FredPoint[] {
  return pts.slice(-count);
}

/** FRED 工具：date → 中文月份标签 "2026年7月" */
function fredMonthLabel(date: string): string {
  const [y, m] = date.split('-');
  return `${y}年${Number(m)}月`;
}

/** FRED 工具：指数序列同比（%），需 13 个点 */
function fredYoy(pts: FredPoint[]): number | null {
  if (pts.length < 13) return null;
  const cur = pts[pts.length - 1];
  const yearAgo = pts[pts.length - 13];
  return Math.round(((cur.value / yearAgo.value) - 1) * 1000) / 10;
}

/** FRED 工具：指数序列环比（%） */
function fredMom(pts: FredPoint[]): number | null {
  if (pts.length < 2) return null;
  const cur = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  return Math.round(((cur.value / prev.value) - 1) * 1000) / 10;
}

/** 解析 FRED → 非农（真实值：PAYEMS 月度增量，千人 → 万人） */
function parseNfpFromFred(fred: FredData, fallback: { next: NfpReport | null; previous: NfpReport | null; daysUntil: number; upcoming: NfpReport[] }): { next: NfpReport | null; previous: NfpReport | null; daysUntil: number; upcoming: NfpReport[] } {
  const pts = fred.payroll;
  if (!pts || pts.length < 3) return fallback;
  const [p2, p1, p0] = fredLatest(pts, 3);
  const actual = Math.round(((p0.value - p1.value) / 10) * 10) / 10; // 千人 → 万人
  const prevActual = Math.round(((p1.value - p2.value) / 10) * 10) / 10; // 前月增量
  const unPts = fred.unemployment;
  const unemploymentRate = unPts && unPts.length > 0 ? fredLatest(unPts, 1)[0].value : null;

  const previous: NfpReport = {
    releaseDate: p0.date,
    label: fredMonthLabel(p0.date),
    actual,
    forecast: null, // 实时模式无机构预期，情绪对比前值
    previous: prevActual,
    unemploymentRate,
    status: 'released',
  };
  return { ...fallback, previous };
}

/** 解析 FRED → CPI（真实值：CPIAUCSL 同比/环比 + 核心同比，前值取上月同比） */
function parseCpiFromFred(fred: FredData, fallback: { next: CpiReport | null; previous: CpiReport | null; daysUntil: number; upcoming: CpiReport[] }): { next: CpiReport | null; previous: CpiReport | null; daysUntil: number; upcoming: CpiReport[] } {
  const pts = fred.cpi;
  if (!pts || pts.length < 14) return fallback;
  const cur = fredLatest(pts, 1)[0];
  const corePts = fred.coreCpi;

  const previous: CpiReport = {
    releaseDate: cur.date,
    label: fredMonthLabel(cur.date),
    yoy: fredYoy(pts),
    mom: fredMom(pts),
    coreYoy: corePts && corePts.length >= 13 ? fredYoy(corePts) : null,
    forecastYoy: null, // 实时模式无机构预期，情绪对比前值
    previousYoy: fredYoy(pts.slice(0, -1)),
    status: 'released',
  };
  return { ...fallback, previous };
}

/** 解析 FRED → 核心 PCE（真实值：PCEPILFE 同比/环比，前值取上月同比） */
function parsePceFromFred(fred: FredData, fallback: { next: PceReport | null; previous: PceReport | null; daysUntil: number; upcoming: PceReport[] }): { next: PceReport | null; previous: PceReport | null; daysUntil: number; upcoming: PceReport[] } {
  const pts = fred.corePce;
  if (!pts || pts.length < 14) return fallback;
  const cur = fredLatest(pts, 1)[0];

  const previous: PceReport = {
    releaseDate: cur.date,
    label: fredMonthLabel(cur.date),
    coreYoy: fredYoy(pts),
    coreMom: fredMom(pts),
    forecastCoreYoy: null, // 实时模式无机构预期，情绪对比前值
    previousCoreYoy: fredYoy(pts.slice(0, -1)),
    status: 'released',
  };
  return { ...fallback, previous };
}

/** 解析 FRED → 初请失业金（真实值：ICSA 周度，人数 → 万人，情绪对比前周） */
function parseClaimsFromFred(fred: FredData, fallback: ReturnType<typeof getJoblessClaims>): ReturnType<typeof getJoblessClaims> {
  const pts = fred.claims;
  if (!pts || pts.length < 2) return fallback;
  const [prev, cur] = fredLatest(pts, 2);

  const latest: JoblessClaimsReport = {
    releaseDate: cur.date,
    actual: Math.round((cur.value / 10000) * 10) / 10, // 人数 → 万人
    forecast: null, // 实时模式无机构预期，情绪对比前周
    previous: Math.round((prev.value / 10000) * 10) / 10,
    status: 'released',
  };
  return { ...fallback, latest };
}

// ==================== Google News RSS 新闻抓取 ====================

export type NewsSentiment = 'bullish' | 'bearish' | 'neutral';

/**
 * 新闻利好/利空分类（服务端关键词打分，客观可解释，零 AI 成本）
 * 中文财经语境：降息/宽松/流入/新高 = 利好；加息/鹰派/监管打击/流出/爆仓 = 利空；打平 = 中性
 * 否定短语优先且加权（不降息 = 利空，不加息 = 利好）
 */
const BULLISH_KW = ['降息', '宽松', '鸽派', '降准', '刺激经济', '注资', '批准', '获批', '利好',
  '上涨', '大涨', '飙升', '暴涨', '新高', '流入', '增持', '买入', '扫货', '采用',
  '合作', '上架', '上线', '减半', '回购', '放宽', '松绑', '合规', '明朗', '牛市', '看涨'];
const BEARISH_KW = ['加息', '鹰派', '收紧', '缩表', '禁止', '禁令', '打压', '罚款', '处罚',
  '起诉', '诉讼', '调查', '黑客', '被盗', '攻击', '漏洞', '爆仓', '清算',
  '暴跌', '大跌', '下挫', '跌破', '流出', '减持', '抛售', '做空', '看空', '警告',
  '崩盘', '裁员', '破产', '冻结', '制裁', '关税', '避险', '熊市', '利空', '下跌'];
const NEGATED_BULLISH = ['不降息', '暂停降息', '推迟降息', '搁置降息', '否认降息', '降息无望', '降息落空', '不降准'];
const NEGATED_BEARISH = ['不加息', '暂停加息', '推迟加息', '否认加息', '加息无望', '加息落空'];

export function classifySentiment(title: string): NewsSentiment {
  let score = 0;
  for (const p of NEGATED_BULLISH) if (title.includes(p)) score -= 2;
  for (const p of NEGATED_BEARISH) if (title.includes(p)) score += 2;
  for (const k of BULLISH_KW) if (title.includes(k)) score += 1;
  for (const k of BEARISH_KW) if (title.includes(k)) score -= 1;
  return score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
}

export interface MacroNewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number; // ms 时间戳
  /** 利好/利空/中性（服务端关键词分类） */
  sentiment: NewsSentiment;
}

const NEWS_CACHE_MS = 10 * 60_000; // 10 分钟缓存
const NEWS_WINDOW_MS = 48 * 60 * 60_000; // 只保留 48 小时内的新闻
const MAX_PER_FEED = 15;

const feedCache: Record<string, { data: MacroNewsItem[]; at: number }> = {};

const GN = 'https://news.google.com/rss/search?q=';
const GN_SUFFIX = '&hl=zh-CN&gl=CN&ceid=CN:zh-Hans';

/** 抓取单条 RSS 文本（带 UA 与超时） */
async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*', 'User-Agent': 'Mozilla/5.0 (compatible; TradingApp/1.0)' },
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** XML 实体解码 */
function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 解析 Google News RSS → 新闻列表（时间倒序，48h 内，最多 MAX_PER_FEED 条） */
function parseGoogleNewsRss(xml: string): MacroNewsItem[] {
  const items: MacroNewsItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < 60) {
    const block = m[1];
    const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
    const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block);
    const dateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/.exec(block);
    if (!titleMatch) continue;

    const title = decodeXml(titleMatch[1]);
    if (!title) continue;
    // Google News 标题自带 " - 媒体名" 后缀，source 标签也有 — 统一从 source 标签取
    const source = sourceMatch ? decodeXml(sourceMatch[1]) : 'Google News';
    const cleanTitle = title.endsWith(` - ${source}`) ? title.slice(0, -(` - ${source}`).length) : title;

    const ts = dateMatch ? Date.parse(decodeXml(dateMatch[1])) : NaN;
    items.push({
      title: cleanTitle,
      link: linkMatch ? linkMatch[1].trim() : '',
      source,
      publishedAt: Number.isFinite(ts) ? ts : 0,
      sentiment: classifySentiment(cleanTitle),
    });
  }

  const now = Date.now();
  return items
    .filter((i) => i.publishedAt > 0 && now - i.publishedAt <= NEWS_WINDOW_MS && i.link)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_PER_FEED);
}

/** 抓取一组新闻（缓存 10 分钟） */
async function fetchFeed(cacheKey: string, query: string): Promise<MacroNewsItem[]> {
  const cached = feedCache[cacheKey];
  if (cached && Date.now() - cached.at < NEWS_CACHE_MS) return cached.data;

  const xml = await fetchText(GN + encodeURIComponent(query) + GN_SUFFIX);
  const data = xml ? parseGoogleNewsRss(xml) : [];
  if (data.length > 0) feedCache[cacheKey] = { data, at: Date.now() };
  else if (cached) return cached.data; // 抓取失败时退回旧缓存
  return data;
}

// ==================== 汇总入口 ====================

export interface MacroNewsResult {
  rate: RateState;
  fomc: { next: FomcMeeting | null; daysUntil: number; upcoming: FomcMeeting[] };
  /** 非农就业数据 */
  nfp: { next: NfpReport | null; previous: NfpReport | null; daysUntil: number; upcoming: NfpReport[] };
  /** CPI 消费者物价指数 */
  cpi: { next: CpiReport | null; previous: CpiReport | null; daysUntil: number; upcoming: CpiReport[] };
  /** PCE 物价指数 */
  pce: { next: PceReport | null; previous: PceReport | null; daysUntil: number; upcoming: PceReport[] };
  /** 初请失业金 */
  jobless: ReturnType<typeof getJoblessClaims>;
  /** 恐慌贪婪指数 */
  fearGreed: FearGreedData;
  /** BTC 实时行情 */
  btc: BtcTicker | null;
  /** 数据源标记：live = 实时 API / static = 内置估算（降级） */
  source: {
    fearGreed: 'live' | 'static';
    nfp: 'live' | 'static';
    cpi: 'live' | 'static';
    pce: 'live' | 'static';
    jobless: 'live' | 'static';
    btc: 'live' | 'static';
  };
  /** 宏观·加息降息新闻 */
  macroNews: MacroNewsItem[];
  /** 加密市场新闻 */
  cryptoNews: MacroNewsItem[];
}

/**
 * 获取消息面全量数据（优先实时 API，失败降级内置数据）
 * 数据源：
 * - 恐慌贪婪指数：alternative.me 官方 API（实时）
 * - 非农/CPI/PCE/失业率/初请：FRED 圣路易斯联储官方 CSV（实时，缓存 2h）
 * - BTC 行情：Binance（实时，与 K 线同源）
 */
export async function fetchMacroNews(): Promise<MacroNewsResult> {
  const [macroNews, cryptoNews, fgLive, fred, btcLive] = await Promise.all([
    fetchFeed('macro', '美联储 OR FOMC OR 加息 OR 降息 OR 非农 OR CPI OR PCE OR 通胀 OR 失业金'),
    fetchFeed('crypto', '比特币 OR 以太坊 OR 加密货币 OR 比特币ETF'),
    fetchFearGreedLive(),
    fetchFredSeries(),
    fetchBtcTicker(),
  ]);

  // 内置降级值
  const nfpFallback = nextNfp();
  const cpiFallback = nextCpi();
  const pceFallback = nextPce();
  const joblessFallback = getJoblessClaims();
  const fgFallback = getFearGreedIndex();

  // FRED 实时数据合并（拉不到则用内置）
  const nfp = fred ? parseNfpFromFred(fred, nfpFallback) : nfpFallback;
  const cpi = fred ? parseCpiFromFred(fred, cpiFallback) : cpiFallback;
  const pce = fred ? parsePceFromFred(fred, pceFallback) : pceFallback;
  const jobless = fred ? parseClaimsFromFred(fred, joblessFallback) : joblessFallback;

  const source = {
    fearGreed: (fgLive ? 'live' : 'static') as 'live' | 'static',
    nfp: (fred && fred.payroll && fred.payroll.length > 0 ? 'live' : 'static') as 'live' | 'static',
    cpi: (fred && fred.cpi && fred.cpi.length > 0 ? 'live' : 'static') as 'live' | 'static',
    pce: (fred && fred.corePce && fred.corePce.length > 0 ? 'live' : 'static') as 'live' | 'static',
    jobless: (fred && fred.claims && fred.claims.length > 0 ? 'live' : 'static') as 'live' | 'static',
    btc: (btcLive ? 'live' : 'static') as 'live' | 'static',
  };

  return {
    rate: RATE_STATE,
    fomc: nextFomc(),
    nfp,
    cpi,
    pce,
    jobless,
    fearGreed: fgLive ?? fgFallback,
    btc: btcLive,
    source,
    macroNews,
    cryptoNews,
  };
}

/** 生成"今日要闻"纯文本（一键复制用，零 AI 成本） */
export function buildDailyDigest(r: MacroNewsResult): string {
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const tag = (s: NewsSentiment) => (s === 'bullish' ? '[利好]' : s === 'bearish' ? '[利空]' : '[中性]');
  const stats = (list: MacroNewsItem[]) => {
    const b = list.filter((n) => n.sentiment === 'bullish').length;
    const x = list.filter((n) => n.sentiment === 'bearish').length;
    return b + x > 0 ? `（利好 ${b} / 利空 ${x} / 中性 ${list.length - b - x}）` : '';
  };
  const lines: string[] = [];

  lines.push(`【消息面速览 · ${new Date().toLocaleDateString('zh-CN')}】`);
  lines.push('');
  lines.push(`■ 美联储利率：${r.rate.rangeLow.toFixed(2)}%–${r.rate.rangeHigh.toFixed(2)}%（${r.rate.lastDecisionNote}）`);
  if (r.fomc.next) {
    lines.push(`■ 下次 FOMC：${r.fomc.next.label}（${r.fomc.daysUntil} 天后）${r.fomc.next.hasSEP ? ' · 附经济预测与点阵图' : ''}`);
  }
  // 非农数据
  if (r.nfp.next) {
    const nfpLine = r.nfp.previous && r.nfp.previous.actual !== null
      ? `■ 非农就业：${r.nfp.previous.label} ${r.nfp.previous.actual}万 · 下次 ${r.nfp.next.label}（${r.nfp.daysUntil} 天后）`
      : `■ 下次非农：${r.nfp.next.label}（${r.nfp.daysUntil} 天后）`;
    lines.push(nfpLine);
  }
  // CPI
  if (r.cpi.previous && r.cpi.previous.yoy !== null) {
    lines.push(`■ CPI 通胀：${r.cpi.previous.label}同比 ${r.cpi.previous.yoy}% · 核心 ${r.cpi.previous.coreYoy}%${r.cpi.next ? ` · 下次（${r.cpi.daysUntil} 天后）` : ''}`);
  }
  // PCE
  if (r.pce.previous && r.pce.previous.coreYoy !== null) {
    lines.push(`■ 核心 PCE：${r.pce.previous.label} ${r.pce.previous.coreYoy}%（美联储首选指标）${r.pce.next ? ` · 下次（${r.pce.daysUntil} 天后）` : ''}`);
  }
  // 初请失业金
  if (r.jobless.latest && r.jobless.latest.actual !== null) {
    lines.push(`■ 初请失业金：${r.jobless.latest.releaseDate}当周 ${r.jobless.latest.actual}万 · 下次（${r.jobless.daysUntil} 天后）`);
  }
  lines.push('');

  // 加密数据
  lines.push(`■ 恐慌贪婪指数：${r.fearGreed.value}（${r.fearGreed.classification}）`);
  if (r.btc) {
    lines.push(`■ BTC：$${r.btc.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}（24h ${r.btc.change24h >= 0 ? '+' : ''}${r.btc.change24h}%）`);
  }
  lines.push('');

  if (r.macroNews.length > 0) {
    lines.push(`■ 宏观·加息降息${stats(r.macroNews)}`);
    r.macroNews.slice(0, 5).forEach((n, i) => lines.push(`${i + 1}. ${tag(n.sentiment)} ${n.title}（${n.source} ${fmtTime(n.publishedAt)}）`));
    lines.push('');
  }
  if (r.cryptoNews.length > 0) {
    lines.push(`■ 加密市场${stats(r.cryptoNews)}`);
    r.cryptoNews.slice(0, 5).forEach((n, i) => lines.push(`${i + 1}. ${tag(n.sentiment)} ${n.title}（${n.source} ${fmtTime(n.publishedAt)}）`));
    lines.push('');
  }
  lines.push('— 数据来自公开新闻源，标签为关键词分类，不构成投资建议');
  return lines.join('\n');
}
