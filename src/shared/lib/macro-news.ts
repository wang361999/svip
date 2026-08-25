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

// ==================== Google News RSS 新闻抓取 ====================

export interface MacroNewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number; // ms 时间戳
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
  /** 宏观·加息降息新闻（美联储/利率/FOMC/CPI 等） */
  macroNews: MacroNewsItem[];
  /** 加密市场新闻（比特币/以太坊/加密货币） */
  cryptoNews: MacroNewsItem[];
}

/** 获取消息面全量数据（利率事实 + FOMC 倒计时 + 双源新闻，10 分钟缓存） */
export async function fetchMacroNews(): Promise<MacroNewsResult> {
  const [macroNews, cryptoNews] = await Promise.all([
    fetchFeed('macro', '美联储 OR FOMC OR 加息 OR 降息 OR 联邦基金利率'),
    fetchFeed('crypto', '比特币 OR 以太坊 OR 加密货币'),
  ]);
  return {
    rate: RATE_STATE,
    fomc: nextFomc(),
    macroNews,
    cryptoNews,
  };
}

/** 生成"今日要闻"纯文本（一键复制用，零 AI 成本） */
export function buildDailyDigest(r: MacroNewsResult): string {
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const lines: string[] = [];

  lines.push(`【消息面速览 · ${new Date().toLocaleDateString('zh-CN')}】`);
  lines.push('');
  lines.push(`■ 美联储利率：${r.rate.rangeLow.toFixed(2)}%–${r.rate.rangeHigh.toFixed(2)}%（${r.rate.lastDecisionNote}）`);
  if (r.fomc.next) {
    lines.push(`■ 下次 FOMC：${r.fomc.next.label}（${r.fomc.daysUntil} 天后）${r.fomc.next.hasSEP ? ' · 附经济预测与点阵图' : ''}`);
  }
  lines.push('');

  if (r.macroNews.length > 0) {
    lines.push('■ 宏观·加息降息');
    r.macroNews.slice(0, 5).forEach((n, i) => lines.push(`${i + 1}. ${n.title}（${n.source} ${fmtTime(n.publishedAt)}）`));
    lines.push('');
  }
  if (r.cryptoNews.length > 0) {
    lines.push('■ 加密市场');
    r.cryptoNews.slice(0, 5).forEach((n, i) => lines.push(`${i + 1}. ${n.title}（${n.source} ${fmtTime(n.publishedAt)}）`));
    lines.push('');
  }
  lines.push('— 数据来自公开新闻源，不构成投资建议');
  return lines.join('\n');
}
