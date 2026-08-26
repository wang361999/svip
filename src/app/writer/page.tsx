'use client';

/**
 * 消息面页面
 *
 * 板块：
 * 1. 核心利率卡 — 美联储利率 + FOMC 倒计时
 * 2. 重磅宏观（2列）— 非农就业 + CPI 通胀
 * 3. 辅助宏观（2列）— PCE 物价指数 + 初请失业金
 * 4. 加密情绪（2列）— 恐慌贪婪指数 + BTC ETF 资金流向
 * 5. 新闻流 — 双 tab：宏观 / 加密（Google News 中文，48h 内）
 * 6. 一键复制今日要闻
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiGet } from '@/shared/api/client';
import useAuthStore from '@/store/authStore';

interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

interface FomcMeeting {
  decisionDate: string;
  label: string;
  hasSEP: boolean;
}

interface NfpReport {
  releaseDate: string;
  label: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  unemploymentRate: number | null;
  status: 'released' | 'upcoming';
}

interface CpiReport {
  releaseDate: string;
  label: string;
  yoy: number | null;
  mom: number | null;
  coreYoy: number | null;
  forecastYoy: number | null;
  previousYoy: number | null;
  status: 'released' | 'upcoming';
}

interface PceReport {
  releaseDate: string;
  label: string;
  coreYoy: number | null;
  coreMom: number | null;
  forecastCoreYoy: number | null;
  previousCoreYoy: number | null;
  status: 'released' | 'upcoming';
}

interface JoblessClaimsReport {
  releaseDate: string;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
  status: 'released' | 'upcoming';
}

interface FearGreedData {
  value: number;
  classification: string;
  yesterday: number;
  lastWeek: number;
  lastMonth: number;
  updatedAt: string;
}

interface BtcTicker {
  price: number;
  change24h: number;
  volumeUsd: number;
  high24h: number;
  low24h: number;
  updatedAt: string;
}

interface MacroNewsData {
  rate: { rangeLow: number; rangeHigh: number; lastDecisionDate: string; lastDecisionNote: string; updatedAt: string };
  fomc: { next: FomcMeeting | null; daysUntil: number; upcoming: FomcMeeting[] };
  nfp: { next: NfpReport | null; previous: NfpReport | null; daysUntil: number; upcoming: NfpReport[] };
  cpi: { next: CpiReport | null; previous: CpiReport | null; daysUntil: number; upcoming: CpiReport[] };
  pce: { next: PceReport | null; previous: PceReport | null; daysUntil: number; upcoming: PceReport[] };
  jobless: { latest: JoblessClaimsReport | null; next: JoblessClaimsReport | null; daysUntil: number; recent: JoblessClaimsReport[] };
  fearGreed: FearGreedData;
  btc: BtcTicker | null;
  source: {
    fearGreed: 'live' | 'static';
    nfp: 'live' | 'static';
    cpi: 'live' | 'static';
    jobless: 'live' | 'static';
    btc: 'live' | 'static';
  };
  macroNews: NewsItem[];
  cryptoNews: NewsItem[];
  digest: string;
}

/** 实时数据源徽章 */
function LiveBadge({ isLive }: { isLive: boolean }) {
  return isLive ? (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border text-green-400 bg-green-500/10 border-green-500/30">
      <span className="w-1 h-1 rounded-full bg-green-400 animate-pulse" />
      实时
    </span>
  ) : (
    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border text-dark-500 bg-dark-800/60 border-dark-700">
      离线参考
    </span>
  );
}

type Tab = 'macro' | 'crypto';

export default function MacroNewsPage() {
  const router = useRouter();
  const { setUser } = useAuthStore();
  const [data, setData] = useState<MacroNewsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('macro');
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await apiGet<MacroNewsData>('/api/macro-news');
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // 登录守卫 + 首次加载
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meData = await apiGet<{ user: Parameters<typeof setUser>[0] }>('/api/auth/me');
        if (!cancelled) setUser(meData.user);
      } catch {
        if (!cancelled) router.push('/login');
        return;
      }
      await load();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 60 秒自动刷新（BTC 行情实时 / 恐慌贪婪每日 / BLS 缓存 2h / 新闻缓存 10min）
  useEffect(() => {
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyDigest = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.digest);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const fmtTime = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  };

  const newsList = tab === 'macro' ? data?.macroNews : data?.cryptoNews;

  // 利好/利空标签样式
  const sentimentCfg: Record<NewsItem['sentiment'], { label: string; cls: string }> = {
    bullish: { label: '利好', cls: 'text-green-400 bg-green-500/10 border-green-500/30' },
    bearish: { label: '利空', cls: 'text-red-400 bg-red-500/10 border-red-500/30' },
    neutral: { label: '中性', cls: 'text-dark-400 bg-dark-800/80 border-dark-700' },
  };

  // 当前板块利好/利空统计
  const stats = (() => {
    if (!newsList || newsList.length === 0) return null;
    const b = newsList.filter((n) => n.sentiment === 'bullish').length;
    const x = newsList.filter((n) => n.sentiment === 'bearish').length;
    return { b, x, n: newsList.length - b - x };
  })();

  return (
    <main className="min-h-screen bg-dark-950 pt-16">
      <div className="max-w-5xl mx-auto px-4 py-8">
        {/* 顶栏 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold text-white">消息面</h1>
            <p className="text-xs text-dark-500 mt-1">实时宏观数据 · 加密情绪 · 每 60 秒自动刷新</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={load} disabled={loading} className="text-xs text-dark-400 hover:text-white transition-colors">
              {loading ? '刷新中…' : '↻ 刷新'}
            </button>
            <Link href="/trading" className="text-xs text-dark-400 hover:text-white transition-colors">
              ← 返回交易
            </Link>
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm mb-4">{error}</div>
        )}

        {/* 美联储利率卡 */}
        {data && (
          <div className="glass-card p-5 mb-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="text-dark-500 text-xs">联邦基金利率目标区间</div>
                  <span className="px-2 py-0.5 rounded text-[10px] font-medium border text-amber-400 bg-amber-500/10 border-amber-500/30">
                    高利率环境（偏空）
                  </span>
                </div>
                <div className="text-3xl font-bold text-white leading-none">
                  {data.rate.rangeLow.toFixed(2)}
                  <span className="text-dark-500 text-lg mx-1">–</span>
                  {data.rate.rangeHigh.toFixed(2)}
                  <span className="text-lg ml-1">%</span>
                </div>
                <div className="text-dark-400 text-xs mt-2">{data.rate.lastDecisionNote}</div>
              </div>
              {data.fomc.next && (
                <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-3 text-center min-w-[120px]">
                  <div className="text-dark-400 text-[10px] mb-0.5">下次 FOMC 决议</div>
                  <div className="text-white text-lg font-bold leading-none">{data.fomc.daysUntil} 天</div>
                  <div className="text-blue-400 text-xs mt-1">
                    {data.fomc.next.label}
                    {data.fomc.next.hasSEP && <span className="text-dark-500"> · 带点阵图</span>}
                  </div>
                </div>
              )}
            </div>

            {/* 2026 剩余会议 */}
            {data.fomc.upcoming.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-dark-800">
                <span className="text-dark-500 text-xs py-1">2026 剩余会议：</span>
                {data.fomc.upcoming.map((m) => (
                  <span key={m.decisionDate} className="px-2.5 py-1 rounded-lg bg-dark-800/60 border border-dark-700 text-xs text-dark-300">
                    {m.label}
                    {m.hasSEP && <span className="text-dark-500 ml-1">*</span>}
                  </span>
                ))}
                <span className="text-dark-600 text-[10px] py-1.5 self-end">* 附经济预测摘要（SEP）与点阵图</span>
              </div>
            )}
            <div className="text-dark-600 text-[10px] mt-3">
              利率数据截至 {data.rate.lastDecisionDate} 决议 · 资料来源：美联储官网
            </div>
          </div>
        )}

        {/* ===== 重磅宏观 ===== */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3 px-1">
            <div className="w-1 h-4 bg-amber-500 rounded-full" />
            <h2 className="text-sm font-semibold text-white">重磅宏观</h2>
            <span className="text-dark-600 text-xs">影响利率决策的核心数据</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 非农就业 */}
            {data && data.nfp.previous && (
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-dark-500 text-xs">非农就业（NFP）</span>
                    <LiveBadge isLive={data.source.nfp === 'live'} />
                  </div>
                  {data.nfp.previous.actual !== null && data.nfp.previous.forecast !== null && (
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                      data.nfp.previous.actual > data.nfp.previous.forecast
                        ? 'text-red-400 bg-red-500/10 border-red-500/30'
                        : data.nfp.previous.actual < data.nfp.previous.forecast
                        ? 'text-green-400 bg-green-500/10 border-green-500/30'
                        : 'text-dark-400 bg-dark-800/80 border-dark-700'
                    }`}>
                      {data.nfp.previous.actual > data.nfp.previous.forecast ? '利空' : data.nfp.previous.actual < data.nfp.previous.forecast ? '利好' : '中性'}
                    </span>
                  )}
                </div>
                {data.nfp.previous.actual !== null ? (
                  <div className="text-2xl font-bold text-white leading-none">
                    {data.nfp.previous.actual}
                    <span className="text-base ml-1 text-dark-400">万</span>
                  </div>
                ) : (
                  <div className="text-dark-400 text-sm">待公布</div>
                )}
                <div className="text-dark-500 text-[11px] mt-1.5">{data.nfp.previous.label}</div>
                <div className="flex gap-4 mt-3 pt-3 border-t border-dark-800">
                  <div>
                    <div className="text-dark-600 text-[10px]">预期</div>
                    <div className="text-dark-300 text-xs">{data.nfp.previous.forecast ?? '—'} 万</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">失业率</div>
                    <div className="text-dark-300 text-xs">{data.nfp.previous.unemploymentRate ?? '—'}%</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">下次公布</div>
                    <div className="text-amber-400 text-xs font-medium">{data.nfp.daysUntil} 天后</div>
                  </div>
                </div>
              </div>
            )}

            {/* CPI 通胀 */}
            {data && data.cpi.previous && (
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-dark-500 text-xs">CPI 消费者物价指数</span>
                    <LiveBadge isLive={data.source.cpi === 'live'} />
                  </div>
                  {data.cpi.previous.yoy !== null && data.cpi.previous.forecastYoy !== null && (
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                      data.cpi.previous.yoy > data.cpi.previous.forecastYoy
                        ? 'text-red-400 bg-red-500/10 border-red-500/30'
                        : data.cpi.previous.yoy < data.cpi.previous.forecastYoy
                        ? 'text-green-400 bg-green-500/10 border-green-500/30'
                        : 'text-dark-400 bg-dark-800/80 border-dark-700'
                    }`}>
                      {data.cpi.previous.yoy > data.cpi.previous.forecastYoy ? '利空（超预期）' : data.cpi.previous.yoy < data.cpi.previous.forecastYoy ? '利好（低于预期）' : '中性'}
                    </span>
                  )}
                </div>
                {data.cpi.previous.yoy !== null ? (
                  <div className="text-2xl font-bold text-white leading-none">
                    {data.cpi.previous.yoy}
                    <span className="text-base ml-1 text-dark-400">%</span>
                    <span className="text-dark-500 text-xs ml-2">同比</span>
                  </div>
                ) : (
                  <div className="text-dark-400 text-sm">待公布</div>
                )}
                <div className="text-dark-500 text-[11px] mt-1.5">{data.cpi.previous.label}</div>
                <div className="flex gap-4 mt-3 pt-3 border-t border-dark-800">
                  <div>
                    <div className="text-dark-600 text-[10px]">核心 CPI</div>
                    <div className="text-dark-300 text-xs">{data.cpi.previous.coreYoy ?? '—'}%</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">环比</div>
                    <div className="text-dark-300 text-xs">{data.cpi.previous.mom ?? '—'}%</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">下次公布</div>
                    <div className="text-amber-400 text-xs font-medium">{data.cpi.daysUntil} 天后</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== 辅助宏观 ===== */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3 px-1">
            <div className="w-1 h-4 bg-blue-500 rounded-full" />
            <h2 className="text-sm font-semibold text-white">辅助宏观</h2>
            <span className="text-dark-600 text-xs">补充验证利率方向</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* PCE 物价指数 */}
            {data && data.pce.previous && (
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-dark-500 text-xs">核心 PCE<span className="text-dark-600 ml-1">· 美联储首选</span></span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium border text-dark-500 bg-dark-800/60 border-dark-700">离线参考</span>
                  </div>
                  {data.pce.previous.coreYoy !== null && data.pce.previous.forecastCoreYoy !== null && (
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                      data.pce.previous.coreYoy > data.pce.previous.forecastCoreYoy
                        ? 'text-red-400 bg-red-500/10 border-red-500/30'
                        : data.pce.previous.coreYoy < data.pce.previous.forecastCoreYoy
                        ? 'text-green-400 bg-green-500/10 border-green-500/30'
                        : 'text-dark-400 bg-dark-800/80 border-dark-700'
                    }`}>
                      {data.pce.previous.coreYoy > data.pce.previous.forecastCoreYoy ? '利空' : data.pce.previous.coreYoy < data.pce.previous.forecastCoreYoy ? '利好' : '中性'}
                    </span>
                  )}
                </div>
                {data.pce.previous.coreYoy !== null ? (
                  <div className="text-2xl font-bold text-white leading-none">
                    {data.pce.previous.coreYoy}
                    <span className="text-base ml-1 text-dark-400">%</span>
                    <span className="text-dark-500 text-xs ml-2">同比</span>
                  </div>
                ) : (
                  <div className="text-dark-400 text-sm">待公布</div>
                )}
                <div className="text-dark-500 text-[11px] mt-1.5">{data.pce.previous.label}</div>
                <div className="flex gap-4 mt-3 pt-3 border-t border-dark-800">
                  <div>
                    <div className="text-dark-600 text-[10px]">环比</div>
                    <div className="text-dark-300 text-xs">{data.pce.previous.coreMom ?? '—'}%</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">预期</div>
                    <div className="text-dark-300 text-xs">{data.pce.previous.forecastCoreYoy ?? '—'}%</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">下次公布</div>
                    <div className="text-blue-400 text-xs font-medium">{data.pce.daysUntil} 天后</div>
                  </div>
                </div>
              </div>
            )}

            {/* 初请失业金 */}
            {data && data.jobless.latest && (
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-dark-500 text-xs">初请失业金<span className="text-dark-600 ml-1">· 每周</span></span>
                    <LiveBadge isLive={data.source.jobless === 'live'} />
                  </div>
                  {data.jobless.latest.actual !== null && data.jobless.latest.forecast !== null && (
                    <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                      data.jobless.latest.actual < data.jobless.latest.forecast
                        ? 'text-red-400 bg-red-500/10 border-red-500/30'
                        : data.jobless.latest.actual > data.jobless.latest.forecast
                        ? 'text-green-400 bg-green-500/10 border-green-500/30'
                        : 'text-dark-400 bg-dark-800/80 border-dark-700'
                    }`}>
                      {data.jobless.latest.actual < data.jobless.latest.forecast ? '利空' : data.jobless.latest.actual > data.jobless.latest.forecast ? '利好' : '中性'}
                    </span>
                  )}
                </div>
                {data.jobless.latest.actual !== null ? (
                  <div className="text-2xl font-bold text-white leading-none">
                    {data.jobless.latest.actual}
                    <span className="text-base ml-1 text-dark-400">万</span>
                    <span className="text-dark-500 text-xs ml-2">当周</span>
                  </div>
                ) : (
                  <div className="text-dark-400 text-sm">待公布</div>
                )}
                <div className="text-dark-500 text-[11px] mt-1.5">{data.jobless.latest.releaseDate} 当周</div>
                <div className="flex gap-4 mt-3 pt-3 border-t border-dark-800">
                  <div>
                    <div className="text-dark-600 text-[10px]">预期</div>
                    <div className="text-dark-300 text-xs">{data.jobless.latest.forecast ?? '—'} 万</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">前值</div>
                    <div className="text-dark-300 text-xs">{data.jobless.latest.previous ?? '—'} 万</div>
                  </div>
                  <div>
                    <div className="text-dark-600 text-[10px]">下次公布</div>
                    <div className="text-blue-400 text-xs font-medium">{data.jobless.daysUntil} 天后</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== 加密情绪 ===== */}
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3 px-1">
            <div className="w-1 h-4 bg-green-500 rounded-full" />
            <h2 className="text-sm font-semibold text-white">加密情绪</h2>
            <span className="text-dark-600 text-xs">市场温度与资金流向</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 恐慌贪婪指数 */}
            {data && (
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-dark-500 text-xs">恐慌贪婪指数</span>
                    <LiveBadge isLive={data.source.fearGreed === 'live'} />
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                    data.fearGreed.value >= 75
                      ? 'text-red-400 bg-red-500/10 border-red-500/30'
                      : data.fearGreed.value >= 55
                      ? 'text-amber-400 bg-amber-500/10 border-amber-500/30'
                      : data.fearGreed.value >= 45
                      ? 'text-dark-300 bg-dark-800/80 border-dark-700'
                      : data.fearGreed.value >= 25
                      ? 'text-green-400 bg-green-500/10 border-green-500/30'
                      : 'text-green-400 bg-green-500/10 border-green-500/30'
                  }`}>
                    {data.fearGreed.classification}
                  </span>
                </div>
                {/* 仪表盘视觉 */}
                <div className="relative h-16 mb-2">
                  <div className="absolute inset-x-0 bottom-0 h-8 rounded-t-full overflow-hidden bg-dark-800">
                    <div className="absolute inset-0" style={{
                      background: 'linear-gradient(to right, #ef4444 0%, #f59e0b 33%, #eab308 50%, #84cc16 66%, #22c55e 100%)'
                    }} />
                    <div
                      className="absolute bottom-0 w-0.5 bg-white shadow-lg transition-all duration-700"
                      style={{ left: `${data.fearGreed.value}%`, height: '100%', transform: 'translateX(-50%)' }}
                    >
                      <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white rounded-full" />
                    </div>
                  </div>
                  <div className="absolute bottom-1 left-0 text-[9px] text-dark-500">恐惧</div>
                  <div className="absolute bottom-1 right-0 text-[9px] text-dark-500">贪婪</div>
                </div>
                <div className="text-center">
                  <span className="text-3xl font-bold text-white">{data.fearGreed.value}</span>
                  <span className="text-dark-500 text-xs ml-1">/ 100</span>
                </div>
                <div className="flex justify-between mt-3 pt-3 border-t border-dark-800 text-center">
                  <div className="flex-1">
                    <div className="text-dark-600 text-[10px]">昨日</div>
                    <div className="text-dark-300 text-xs font-medium">{data.fearGreed.yesterday}</div>
                  </div>
                  <div className="flex-1 border-l border-dark-800">
                    <div className="text-dark-600 text-[10px]">上周</div>
                    <div className="text-dark-300 text-xs font-medium">{data.fearGreed.lastWeek}</div>
                  </div>
                  <div className="flex-1 border-l border-dark-800">
                    <div className="text-dark-600 text-[10px]">上月</div>
                    <div className="text-dark-300 text-xs font-medium">{data.fearGreed.lastMonth}</div>
                  </div>
                </div>
              </div>
            )}

            {/* BTC 实时行情 */}
            {data && data.btc && (
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1.5">
                    <span className="text-dark-500 text-xs">BTC / USDT</span>
                    <LiveBadge isLive={data.source.btc === 'live'} />
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                    data.btc.change24h > 0
                      ? 'text-red-400 bg-red-500/10 border-red-500/30'
                      : data.btc.change24h < 0
                      ? 'text-green-400 bg-green-500/10 border-green-500/30'
                      : 'text-dark-400 bg-dark-800/80 border-dark-700'
                  }`}>
                    24h {data.btc.change24h >= 0 ? '+' : ''}{data.btc.change24h}%
                  </span>
                </div>
                <div className="text-2xl font-bold text-white leading-none font-mono">
                  ${data.btc.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                </div>
                <div className="text-dark-500 text-[11px] mt-1.5">Binance 现货 · {new Date(data.btc.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</div>
                <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-dark-800 text-center">
                  <div>
                    <div className="text-dark-600 text-[10px]">24h 最高</div>
                    <div className="text-dark-300 text-xs font-medium font-mono">{data.btc.high24h.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div className="border-l border-dark-800">
                    <div className="text-dark-600 text-[10px]">24h 最低</div>
                    <div className="text-dark-300 text-xs font-medium font-mono">{data.btc.low24h.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div>
                  </div>
                  <div className="border-l border-dark-800">
                    <div className="text-dark-600 text-[10px]">24h 成交</div>
                    <div className="text-dark-300 text-xs font-medium font-mono">{data.btc.volumeUsd}亿$</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 新闻流 */}
        <div className="glass-card p-4">
          {/* Tab 切换 */}
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setTab('macro')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                tab === 'macro'
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'text-dark-300 bg-dark-800 border-dark-700 hover:text-white'
              }`}
            >
              宏观 · 加息降息
            </button>
            <button
              onClick={() => setTab('crypto')}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                tab === 'crypto'
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'text-dark-300 bg-dark-800 border-dark-700 hover:text-white'
              }`}
            >
              加密市场
            </button>
            {stats && (
              <span className="text-dark-600 text-xs ml-auto flex items-center gap-1.5">
                <span className="text-green-500">利好 {stats.b}</span>
                <span className="text-dark-700">/</span>
                <span className="text-red-500">利空 {stats.x}</span>
                <span className="text-dark-700">/</span>
                <span>中性 {stats.n}</span>
              </span>
            )}
          </div>

          {/* 列表 */}
          {loading && !data && (
            <div className="flex items-center justify-center py-12">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {data && newsList && newsList.length === 0 && (
            <div className="text-center py-10 text-dark-400 text-sm">暂无新闻（抓取失败或超出 48 小时窗口）</div>
          )}

          <div className="space-y-1">
            {newsList?.map((n, i) => (
              <a
                key={`${n.link}-${i}`}
                href={n.link}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-3 py-2.5 rounded-lg hover:bg-dark-800/60 transition-colors group"
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-1 w-1 h-1 rounded-full flex-shrink-0 ${tab === 'macro' ? 'bg-blue-400' : 'bg-amber-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2">
                      <div className="text-dark-200 text-sm leading-relaxed group-hover:text-white transition-colors flex-1">
                        {n.title}
                      </div>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border flex-shrink-0 ${sentimentCfg[n.sentiment].cls}`}>
                        {sentimentCfg[n.sentiment].label}
                      </span>
                    </div>
                    <div className="text-dark-600 text-xs mt-1">
                      {n.source} · {fmtTime(n.publishedAt)}
                    </div>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>

        {/* 复制今日要闻 */}
        {data && (
          <div className="mt-5">
            <button
              onClick={copyDigest}
              className={`w-full px-4 py-3 rounded-xl text-sm font-medium border transition-colors ${
                copied
                  ? 'text-green-400 border-green-500/40 bg-green-500/10'
                  : 'text-white bg-blue-600 border-blue-500 hover:bg-blue-700'
              }`}
            >
              {copied ? '✓ 已复制今日要闻' : '📋 一键复制今日要闻'}
            </button>
            <p className="text-center text-[11px] text-dark-600 mt-3">
              非农/CPI/初请来自美国劳工统计局（BLS）· 恐慌贪婪来自 alternative.me · BTC 行情来自 Binance · PCE 为内置参考
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
