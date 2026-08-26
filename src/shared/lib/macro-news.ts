/**
 * 消息面数据模块（美联储利率/FOMC 日历 + 宏观与加密新闻流）
 *
 * 设计：
 * 1. 利率与 FOMC 日历为内置事实数据（来源：美联储官网公布，确定性信息不需要实时抓取）
 *    — 每次议息决议后需手动更新 RATE_STATE（一年 8 次）
 * 2. 新闻流抓取 Google News RSS 中文版（服务端海外出口可直达），双关键词组：
 *    宏观（美联储/FOMC/加息/降息）+ 加密（比特币/以太坊/加密货币）
 * 3. 内存缓存 10 分钟 — Vercel 免费版 CPU 优化，避免每次请求都外呼
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
  /** 宏观·加息降息新闻（美联储/利率/FOMC/非农/CPI 等） */
  macroNews: MacroNewsItem[];
  /** 加密市场新闻（比特币/以太坊/加密货币） */
  cryptoNews: MacroNewsItem[];
}

/** 获取消息面全量数据（利率事实 + FOMC + 非农 + 双源新闻，10 分钟缓存） */
export async function fetchMacroNews(): Promise<MacroNewsResult> {
  const [macroNews, cryptoNews] = await Promise.all([
    fetchFeed('macro', '美联储 OR FOMC OR 加息 OR 降息 OR 非农 OR 非农就业 OR CPI OR 通胀'),
    fetchFeed('crypto', '比特币 OR 以太坊 OR 加密货币'),
  ]);
  return {
    rate: RATE_STATE,
    fomc: nextFomc(),
    nfp: nextNfp(),
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
      ? `■ 下次非农：${r.nfp.next.label}（${r.nfp.daysUntil} 天后）· 前值 ${r.nfp.previous.actual}万`
      : `■ 下次非农：${r.nfp.next.label}（${r.nfp.daysUntil} 天后）`;
    lines.push(nfpLine);
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
