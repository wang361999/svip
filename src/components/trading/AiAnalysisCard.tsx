'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '@/shared/api/client';
import useSymbolStore from '@/store/symbolStore';

/**
 * AI 结构分析卡片
 *
 * 数字层：规则引擎（structure-analysis.ts）计算，永远准确
 * 文案层：DeepSeek 生成（失败自动降级模板），只组织语言不算数
 * 更新策略：每 4h 收盘自动更新 + 手动刷新按钮
 */

interface Plan {
  id: 'A' | 'B' | 'C';
  name: string;
  side: 'long' | 'short';
  trigger: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  risk: number;
  riskPct: number;
  rrTp1: number;
  rrTp2: number;
  rrBlended: number;
  tp2Source?: string;
  tp1ProbabilityPct?: number;
  tp2ProbabilityPct?: number;
  tp1FirstPct?: number;
  slFirstPct?: number;
  windowRace?: WindowRaceRow[];
  confidence: 'high' | 'medium';
}

interface WindowRaceRow {
  hours: number;
  tp1FirstPct: number;
  slFirstPct: number;
  unresolvedPct: number;
}

/**
 * 圆形盈亏比仪表：环形进度 = 加权盈亏比 / 满刻度(3)，中心为数值。
 * 颜色分级：≥2 绿（优）/ ≥1.2 琥珀（可）/ 其余红（差）。
 * 用 currentColor 描边，避免依赖 stroke-* 工具类。
 */
function RingGauge({ value, max = 3, size = 46 }: { value: number; max?: number; size?: number }) {
  const pct = Math.max(0, Math.min(1, value / max));
  const r = (size - 7) / 2;
  const c = 2 * Math.PI * r;
  const tone =
    value >= 2
      ? { ring: 'text-green-400', label: 'text-green-400' }
      : value >= 1.2
        ? { ring: 'text-amber-400', label: 'text-amber-400' }
        : { ring: 'text-red-400', label: 'text-red-400' };
  return (
    <div
      className="relative shrink-0 leading-none"
      style={{ width: size, height: size }}
      title={`加权盈亏比 ${value}（满刻度 ${max}）`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="currentColor" className="text-dark-700" strokeWidth={4} fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="currentColor"
          className={`${tone.ring} transition-[stroke-dashoffset] duration-500`}
          strokeWidth={4}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-[11px] font-bold font-mono ${tone.label}`}>{value.toFixed(2)}</span>
        <span className="text-[7px] text-dark-500 mt-[1px]">盈亏比</span>
      </div>
    </div>
  );
}

interface KeyLevel {
  price: number;
  label: string;
  distancePct: number;
}

interface ProfitTarget {
  method: string;
  label: string;
  price: number;
  probabilityPct: number;
}

interface ConfluenceZone {
  low: number;
  high: number;
  mid: number;
  methods: string[];
  probabilityPct: number;
}

interface Narrative {
  headline: string;
  biasText: string;
  paragraphs: string[];
  planAComment: string;
  planBComment: string;
  planCComment?: string;
  invalidation: string;
  reminder: string;
  source: 'ai' | 'template';
}

interface AnalysisData {
  symbol: string;
  generatedAt: number;
  currentPrice: number;
  resonanceText: string;
  bias: 'bull' | 'bear' | 'neutral';
  plans: Plan[];
  invalidation: { price: number; note: string } | null;
  keyLevels: KeyLevel[];
  profitTargets?: ProfitTarget[];
  confluence?: ConfluenceZone | null;
  extendedTarget?: ProfitTarget | null;
  eta?: { bars: number; text: string } | null;
  atr?: number;
  directionSignal?: {
    active: boolean;
    dir: 'long' | 'short';
    score: number;
    stateText: string;
    distanceToTrigger: number;
    trendFilterPassed: boolean;
    e200Side: 'above' | 'below';
    historyWinRatePct: number;
    evidenceText: string;
  };
  narrative: Narrative;
  narrativeSource: 'ai' | 'template';
  model: string;
  cached: boolean;
}

const COLLAPSE_KEY = 'ai-analysis-collapsed';
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 静默拉缓存（服务端 4h 缓存兜底，命中时开销极小）

function loadCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function formatPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v >= 1000) return v.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(5);
}

const BIAS_STYLES = {
  bull: { badge: 'bg-green-500/15 text-green-400', icon: '▲', text: 'text-green-400' },
  bear: { badge: 'bg-red-500/15 text-red-400', icon: '▼', text: 'text-red-400' },
  neutral: { badge: 'bg-amber-500/15 text-amber-400', icon: '◆', text: 'text-amber-400' },
};

export default function AiAnalysisCard() {
  const { symbol, label } = useSymbolStore();
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [showLevels, setShowLevels] = useState(false);
  const [showProfit, setShowProfit] = useState(false);

  const load = useCallback(
    async (force = false) => {
      if (!symbol) return;
      if (force) setRefreshing(true);
      try {
        const d = await apiGet<AnalysisData>(
          `/api/structure-analysis?symbol=${symbol}${force ? '&refresh=1' : ''}`,
        );
        if (d && d.plans) {
          setData(d);
          setError('');
        } else if (d && (d as any).error) {
          setError((d as any).message || '数据源暂不可用');
        }
      } catch (err: any) {
        setError(err?.message || '加载失败');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [symbol],
  );

  useEffect(() => {
    setLoading(true);
    setData(null);
    load(false);
    const timer = setInterval(() => load(false), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const bias = BIAS_STYLES[data?.bias || 'neutral'];

  const renderPlan = (plan: Plan, comment: string) => {
    const isLong = plan.side === 'long';
    return (
      <div
        key={plan.id}
        className={`rounded-lg border p-3 ${
          isLong ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'
        }`}
      >
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${
                isLong ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}
            >
              {plan.id}
            </span>
            <span className="text-white text-sm font-semibold truncate">{plan.name}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <RingGauge value={plan.rrBlended} />
            <span className={`text-xs ${isLong ? 'text-green-400' : 'text-red-400'}`}>
              {isLong ? '做多' : '做空'}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-dark-400">{plan.id === 'B' ? '触发' : '入场'}</span>
            <span className="text-white font-mono">{formatPrice(plan.entry)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dark-400">止损</span>
            <span className="text-red-400 font-mono">{formatPrice(plan.stop)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-dark-400">TP1</span>
            <span className="text-green-400 font-mono">
              {formatPrice(plan.tp1)}{' '}
              <span className="text-dark-500">
                ({plan.rrTp1}
                {plan.tp1ProbabilityPct != null ? ` · ${plan.tp1ProbabilityPct}%` : ''})
              </span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-dark-400">TP2</span>
            <span className="text-green-400 font-mono">
              {formatPrice(plan.tp2)}{' '}
              <span className="text-dark-500">
                ({plan.rrTp2}
                {plan.tp2ProbabilityPct != null ? ` · ${plan.tp2ProbabilityPct}%` : ''})
              </span>
            </span>
          </div>
        </div>
        <div className="mt-2 pt-2 border-t border-dark-700/50 flex items-center justify-between text-xs">
          <span className="text-dark-400">
            风险 <span className="text-dark-300 font-mono">{plan.riskPct}%</span>
          </span>
          <span className="text-dark-500" title="环形仪表为 TP1/TP2 加权盈亏比，满刻度 3">
            TP1 {plan.rrTp1} · TP2 {plan.rrTp2}
          </span>
        </div>
        {plan.windowRace && plan.windowRace.length > 0 && (
          <div className="mt-2 pt-2 border-t border-dark-700/50">
            <div className="flex items-center justify-between text-[10px] text-dark-500 mb-1.5">
              <span className="text-dark-400">分持仓窗口 · 谁先触及</span>
              <span>
                <span className="text-green-400">先到止盈</span>
                <span className="text-dark-600"> / </span>
                <span className="text-red-400">先到止损</span>
                <span className="text-dark-600"> / </span>
                <span className="text-dark-400">未触及</span>
              </span>
            </div>
            {plan.windowRace.map((row) => (
              <div key={row.hours} className="flex items-center gap-2 text-[11px] font-mono leading-5">
                <span className="w-9 shrink-0 text-dark-300">{row.hours}h</span>
                <div className="flex-1 h-1.5 rounded-full bg-dark-700/70 overflow-hidden flex">
                  <div className="bg-green-500/70" style={{ width: `${row.tp1FirstPct}%` }} />
                  <div className="bg-red-500/70" style={{ width: `${row.slFirstPct}%` }} />
                </div>
                <span className="w-[7.5rem] shrink-0 text-right tabular-nums">
                  <span className="text-green-400">{row.tp1FirstPct}%</span>
                  <span className="text-dark-600"> / </span>
                  <span className="text-red-400">{row.slFirstPct}%</span>
                  <span className="text-dark-600"> / </span>
                  <span className="text-dark-400">{row.unresolvedPct}%</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {(plan.windowRace || plan.tp1ProbabilityPct != null || plan.tp2ProbabilityPct != null) && (
          <p className="mt-1.5 text-[10px] text-dark-500">
            {plan.id === 'C'
              ? '超短线窗口 2~24h 实测校准（1h 腿回踩，15m 触及收回确认后起算）：止损距约 1%，必须 maker 挂单执行，taker 费率约吃掉 11% 风险单位；ETH 近期样本外先到止盈比表值低 3~7pp，保守看待'
              : plan.windowRace
                ? '窗口竞速为实测校准（逐根判定谁先触发，同根双触按先止损保守计）：持仓越短先到止盈率越低、未触及占比越高，按自己的持仓周期查对应行；条件概率，触发确认入场后有效'
                : 'TP 百分比为条件概率：触发条件确认入场后 30 根 4h 内触及（历史回测校准值）；未触发前不成立'}
          </p>
        )}
        {plan.id === 'B' && (
          <p className="mt-1.5 text-[10px] text-dark-500">
            B 方案不提供先到概率：实测其止损率先到比例随行情机制漂移（全期 21% → 2026 年 35%），无法稳定校准
          </p>
        )}
        {plan.tp2Source && (
          <div className="mt-1.5 text-[11px] text-amber-400/90">
            TP2 依据：{plan.tp2Source}
          </div>
        )}
        <p className="text-dark-300 text-xs mt-2 leading-relaxed">{comment}</p>
      </div>
    );
  };

  return (
    <div className="glass-card p-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between cursor-pointer select-none" onClick={toggleCollapse}>
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold text-sm">AI 结构分析</span>
          <span className="text-dark-400 text-xs">{label}</span>
          {data && !loading && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${bias.badge}`}>
              {bias.icon} {data.narrative?.biasText || '中性'}
            </span>
          )}
          {data && !loading && (
            <span className="text-dark-500 text-[10px] px-1.5 py-0.5 rounded bg-dark-800/80 border border-dark-700/50">
              {data.narrativeSource === 'ai' ? 'AI 解读' : '模板解读'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <span className="text-dark-500 text-xs">分析中...</span>
          ) : (
            data && (
              <span className="text-dark-500 text-xs">
                {new Date(data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            )
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!refreshing) load(true);
            }}
            disabled={refreshing || loading}
            className="p-1 rounded hover:bg-dark-700/60 transition-colors disabled:opacity-40"
            title="立即重新分析"
          >
            <svg
              className={`w-3.5 h-3.5 text-dark-400 ${refreshing ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
          <svg
            className={`w-4 h-4 text-dark-400 transition-transform ${collapsed ? '' : 'rotate-180'}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* 内容区 */}
      {!collapsed && (
        <div className="mt-3 space-y-3">
          {loading && (
            <div className="py-8 text-center text-dark-500 text-sm">正在计算三周期结构 + AI 解读...</div>
          )}

          {!loading && error && !data && (
            <div className="py-6 text-center text-dark-400 text-sm">{error}</div>
          )}

          {!loading && data && (
            <>
              {/* 方向信号卡（实证校准，替代定性偏多偏空作为方向依据） */}
              {data.directionSignal && (
                <div
                  className={`rounded-lg border p-3.5 ${
                    data.directionSignal.active
                      ? data.directionSignal.dir === 'long'
                        ? 'border-emerald-500/40 bg-emerald-500/10'
                        : 'border-rose-500/40 bg-rose-500/10'
                      : 'border-dark-600/60 bg-dark-700/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        data.directionSignal.active
                          ? data.directionSignal.dir === 'long'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-rose-500/20 text-rose-400'
                          : 'bg-dark-600/60 text-dark-300'
                      }`}>
                        {data.directionSignal.active
                          ? `${data.directionSignal.dir === 'long' ? '▲ 做多' : '▼ 做空'} · 已触发`
                          : data.directionSignal.distanceToTrigger < 0.15
                            ? '◆ 接近信号'
                            : '○ 无信号'}
                      </span>
                      <span className="text-dark-300 text-xs">方向信号 · 实证校准</span>
                    </div>
                    {data.directionSignal.active && (
                      <span className="text-emerald-400 font-mono text-lg font-bold">
                        {data.directionSignal.historyWinRatePct}%
                      </span>
                    )}
                  </div>
                  <p className="text-dark-300 text-xs mt-2 leading-relaxed">
                    {data.directionSignal.active ? (
                      <>
                        {data.directionSignal.stateText} · MR {data.directionSignal.score} ·{' '}
                        {data.directionSignal.e200Side === 'above' ? 'EMA200之上（大多头结构）' : 'EMA200之下（大空头结构）'}
                        。历史72h方向命中 <span className="text-dark-100 font-medium">{data.directionSignal.historyWinRatePct}%</span>
                      </>
                    ) : (
                      <>
                        {data.directionSignal.stateText} · MR {data.directionSignal.score}（
                        {data.directionSignal.e200Side === 'above' ? '多头结构，等深度回调至超跌位' : '空头结构，等反弹至超涨位'}，距阈值{' '}
                        {data.directionSignal.distanceToTrigger}）
                      </>
                    )}
                  </p>
                  <p className="text-dark-500 text-[10px] mt-1.5 leading-relaxed">{data.directionSignal.evidenceText}</p>
                </div>
              )}

              {/* 结论区 */}
              <div className={`rounded-lg border p-3.5 ${bias.badge.replace('text-', 'border-').replace(/bg-\S+/, (m) => m.replace('/15', '/10'))}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className={`font-semibold ${bias.text} leading-snug`}>{data.narrative?.headline}</p>
                    <p className="text-dark-400 text-xs mt-1.5">
                      现价 <span className="text-dark-200 font-mono">{formatPrice(data.currentPrice)}</span> · 共振 {data.resonanceText}
                    </p>
                  </div>
                </div>
              </div>

              {/* 多预案（按 id 定位：A 回调 / B 突破 / C 超短线） */}
              {data.plans.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {data.plans.find((p) => p.id === 'A') &&
                    renderPlan(
                      data.plans.find((p) => p.id === 'A')!,
                      data.narrative?.planAComment || data.plans.find((p) => p.id === 'A')!.trigger,
                    )}
                  {data.plans.find((p) => p.id === 'B') &&
                    renderPlan(
                      data.plans.find((p) => p.id === 'B')!,
                      data.narrative?.planBComment || data.plans.find((p) => p.id === 'B')!.trigger,
                    )}
                  {data.plans.find((p) => p.id === 'C') &&
                    renderPlan(
                      data.plans.find((p) => p.id === 'C')!,
                      data.narrative?.planCComment ||
                        data.plans.find((p) => p.id === 'C')!.trigger,
                    )}
                </div>
              )}

              {/* AI 解读段落 */}
              <div className="rounded-lg bg-dark-800/40 border border-dark-700/40 p-3.5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-dark-300 text-xs font-semibold">结构解读</span>
                  <span className="text-dark-600 text-[10px]">数字由规则引擎计算</span>
                </div>
                <div className="space-y-2">
                  {data.narrative?.paragraphs.map((p, i) => (
                    <p key={i} className="text-dark-300 text-xs leading-relaxed">
                      {p}
                    </p>
                  ))}
                </div>
              </div>

              {/* 失效条件 */}
              {data.invalidation && (
                <div className="rounded-lg bg-red-500/5 border border-red-500/20 px-3.5 py-2.5 flex items-start gap-2">
                  <span className="text-red-400 text-xs font-bold shrink-0 mt-0.5">失效</span>
                  <p className="text-red-300/90 text-xs leading-relaxed">{data.narrative?.invalidation}</p>
                </div>
              )}

              {/* 关键位（可展开） */}
              <div>
                <button
                  onClick={() => setShowLevels(!showLevels)}
                  className="flex items-center gap-1.5 text-dark-400 text-xs hover:text-dark-200 transition-colors"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${showLevels ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  关键结构位（{data.keyLevels.length}）
                </button>
                {showLevels && (
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {data.keyLevels.map((k, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded bg-dark-800/40"
                      >
                        <span className="text-dark-400">{k.label}</span>
                        <span className="flex items-center gap-2">
                          <span className="text-dark-200 font-mono">{formatPrice(k.price)}</span>
                          <span className={`font-mono ${k.distancePct >= 0 ? 'text-green-500/70' : 'text-red-500/70'}`}>
                            {k.distancePct >= 0 ? '+' : ''}
                            {k.distancePct}%
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 利润测算（多方法汇流，可展开） */}
              {data.profitTargets && data.profitTargets.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowProfit(!showProfit)}
                    className="flex items-center gap-1.5 text-dark-400 text-xs hover:text-dark-200 transition-colors"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${showProfit ? 'rotate-90' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    利润测算（{data.profitTargets.length} 方法投影
                    {data.confluence ? ` · 汇流区 ${formatPrice(data.confluence.low)}–${formatPrice(data.confluence.high)}` : ' · 暂无汇流'}）
                  </button>
                  {showProfit && (
                    <div className="mt-2 space-y-1.5">
                      {data.confluence && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-amber-400 font-medium">汇流止盈区</span>
                            <span className="text-dark-100 font-mono">
                              {formatPrice(data.confluence.low)}–{formatPrice(data.confluence.high)}
                            </span>
                          </div>
                          <p className="text-dark-400 text-[11px] mt-1">{data.confluence.methods.join(' + ')}</p>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex-1 h-1 rounded-full bg-dark-700/60 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-amber-400"
                                style={{ width: `${data.confluence.probabilityPct}%` }}
                              />
                            </div>
                            <span className="text-dark-300 text-[11px] font-mono shrink-0">
                              {data.confluence.probabilityPct}%
                            </span>
                          </div>
                          <p className="text-dark-500 text-[10px] mt-1">
                            中值 {formatPrice(data.confluence.mid)} · 自现价 30 根 4h 内触及概率（历史回测校准值）
                          </p>
                        </div>
                      )}
                      {data.profitTargets.map((t, i) => (
                        <div
                          key={i}
                          className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded bg-dark-800/40"
                        >
                          <span className="text-dark-400">{t.label}</span>
                          <span className="flex items-center gap-2">
                            <span className="text-dark-200 font-mono">{formatPrice(t.price)}</span>
                            <span className="font-mono text-green-500/70 w-8 text-right">{t.probabilityPct}%</span>
                          </span>
                        </div>
                      ))}
                      {data.extendedTarget && (
                        <p className="text-dark-400 text-[11px]">
                          延伸档：{data.extendedTarget.label} {formatPrice(data.extendedTarget.price)}
                        </p>
                      )}
                      {data.eta && <p className="text-dark-500 text-[11px]">{data.eta.text}</p>}
                      {data.atr != null && data.atr > 0 && (
                        <p className="text-dark-600 text-[10px]">
                          概率为 ETH/BTC/SOL 4h 约 22 个月走查回放的分距离实测校准值（仅覆盖三大主流币，极端行情可能偏离），非理论推导，仅供参考非精确预测
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 提醒 */}
              <p className="text-dark-500 text-[11px] leading-relaxed">
                {data.narrative?.reminder}
                {data.narrativeSource === 'ai' && <span className="text-dark-600"> · 文案模型：{data.model}</span>}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
