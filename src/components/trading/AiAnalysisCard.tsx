'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '@/shared/api/client';
import useSymbolStore from '@/store/symbolStore';

/**
 * AI 结构分析卡片
 *
 * 数字层：规则引擎（structure-analysis.ts）计算，永远准确，30s 实时轮询
 * 文案层：结构解读（DeepSeek，失败自动降级模板）仅手动触发，不随轮询刷新
 * 更新策略：数字每 30s 自动更新 + 手动刷新按钮；结构解读点「生成解读」按需生成
 */

interface Plan {
  id: 'D' | 'E';
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
  confidence: 'high' | 'medium';
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
  planDComment?: string;
  planEComment?: string;
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
  realtimeSignal?: {
    active: boolean;
    dir: 'long' | 'short';
    confidence: 'high' | 'medium';
    triggerSource: string;
    indicators: {
      key: string;
      name: string;
      stateText: string;
      stance: 'long' | 'short' | 'neutral';
      role: 'trigger' | 'context';
      distanceToTrigger?: number;
    }[];
    mrScore: number;
    e200Side: 'above' | 'below';
    historyWinRatePct: number;
    evidenceText: string;
    stateText: string;
  };
  narrative?: Narrative | null;
  narrativeAt?: number | null;
  narrativeSource?: 'ai' | 'template' | null;
  dailyPlan?: {
    bias: 'long' | 'short';
    biasText: string;
    pullbackLevels: { price: number; label: string }[];
    entryZone: { low: number; high: number; mid: number; methods: string[] } | null;
    stopHint: number | null;
    invalidationPrice: number | null;
  } | null;
  model: string;
  cached: boolean;
}

const COLLAPSE_KEY = 'ai-analysis-collapsed';
// 实时档：30s 轮询数字层（服务端 60s 缓存兜底，命中时开销极小）；
// 结构解读（LLM 文案）不随轮询刷新，仅手动触发生成
const AUTO_REFRESH_MS = 30 * 1000;

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
  const [genLoading, setGenLoading] = useState(false);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const [showLevels, setShowLevels] = useState(false);
  const [showProfit, setShowProfit] = useState(false);

  // 数字层实时拉取；返回的 narrative 为 null 时保留已有解读（解读不随轮询刷新）
  const load = useCallback(
    async (force = false) => {
      if (!symbol) return;
      if (force) setRefreshing(true);
      try {
        const d = await apiGet<AnalysisData>(
          `/api/structure-analysis?symbol=${symbol}${force ? '&refresh=1' : ''}`,
        );
        if (d && d.plans) {
          setData((prev) => (d.narrative ? d : { ...d, narrative: prev?.narrative ?? null, narrativeAt: prev?.narrativeAt ?? null }));
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

  // 结构解读（LLM 文案层）：仅手动触发，调 narrative=1 生成
  const genNarrative = useCallback(async () => {
    if (!symbol || genLoading) return;
    setGenLoading(true);
    try {
      const d = await apiGet<AnalysisData>(
        `/api/structure-analysis?symbol=${symbol}&narrative=1`,
      );
      if (d && d.plans && d.narrative) {
        setData((prev) => ({ ...(prev ?? d), ...d }));
        setError('');
      }
    } catch (err: any) {
      setError(err?.message || '解读生成失败');
    } finally {
      setGenLoading(false);
    }
  }, [symbol, genLoading]);

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

  // 徽章方向唯一依据：实证实时信号（未触发一律中性，结构解读不自动改向）
  const biasKey = data?.realtimeSignal?.active
    ? data.realtimeSignal.dir === 'long'
      ? 'bull'
      : 'bear'
    : 'neutral';
  const bias = BIAS_STYLES[biasKey];

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
            <span className="text-dark-400">入场</span>
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
        {plan.tp1ProbabilityPct != null || plan.tp2ProbabilityPct != null ? (
          <p className="mt-1.5 text-[10px] text-dark-500">
            TP 百分比为条件概率：触发条件确认入场后 30 根 4h 内触及（历史回测校准值）；未触发前不成立
          </p>
        ) : null}
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
              {data.narrative
                ? data.narrativeSource === 'ai'
                  ? 'AI 解读'
                  : '模板解读'
                : '实时数据'}
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
            <div className="py-8 text-center text-dark-500 text-sm">正在计算三周期结构...</div>
          )}

          {!loading && error && !data && (
            <div className="py-6 text-center text-dark-400 text-sm">{error}</div>
          )}

          {!loading && data && (
            <>
              {/* 实时信号卡（五指标合议：核心MR + 背离辅助可触发，其余为面板指标） */}
              {data.realtimeSignal && (
                <div
                  className={`rounded-lg border p-3.5 ${
                    data.realtimeSignal.active
                      ? data.realtimeSignal.dir === 'long'
                        ? 'border-emerald-500/40 bg-emerald-500/10'
                        : 'border-rose-500/40 bg-rose-500/10'
                      : 'border-dark-600/60 bg-dark-700/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        data.realtimeSignal.active
                          ? data.realtimeSignal.dir === 'long'
                            ? 'bg-emerald-500/20 text-emerald-400'
                            : 'bg-rose-500/20 text-rose-400'
                          : 'bg-dark-600/60 text-dark-300'
                      }`}>
                        {data.realtimeSignal.active
                          ? `${data.realtimeSignal.dir === 'long' ? '▲ 做多' : '▼ 做空'} · ${data.realtimeSignal.confidence === 'high' ? '高置信' : '中置信'}`
                          : '○ 无信号'}
                      </span>
                      <span className="text-dark-300 text-xs">AI实时信号 · 五指标合议</span>
                    </div>
                    {data.realtimeSignal.active && (
                      <span className="text-emerald-400 font-mono text-lg font-bold">
                        {data.realtimeSignal.historyWinRatePct}%
                      </span>
                    )}
                  </div>
                  <p className="text-dark-300 text-xs mt-2 leading-relaxed">
                    {data.realtimeSignal.active ? (
                      <>
                        {data.realtimeSignal.triggerSource} · MR {data.realtimeSignal.mrScore} ·{' '}
                        {data.realtimeSignal.e200Side === 'above' ? 'EMA200之上（多头结构）' : 'EMA200之下（空头结构）'}
                        。历史命中 <span className="text-dark-100 font-medium">{data.realtimeSignal.historyWinRatePct}%</span>
                      </>
                    ) : (
                      <>
                        {data.realtimeSignal.stateText} · MR {data.realtimeSignal.mrScore}（
                        {data.realtimeSignal.e200Side === 'above' ? '多头结构，等深度回调至超跌位' : '空头结构，等反弹至超涨位'}）
                      </>
                    )}
                  </p>
                  {/* 五指标面板 */}
                  {data.realtimeSignal.indicators.length > 0 && (
                    <div className="mt-2.5 grid grid-cols-1 gap-1">
                      {data.realtimeSignal.indicators.map((ind) => (
                        <div key={ind.key} className="flex items-center gap-2 text-[11px] leading-snug">
                          <span
                            className={`w-1 h-1 rounded-full shrink-0 ${
                              ind.stance === 'long'
                                ? 'bg-emerald-400'
                                : ind.stance === 'short'
                                  ? 'bg-rose-400'
                                  : 'bg-dark-500'
                            }`}
                          />
                          <span className="text-dark-200 shrink-0 font-medium">
                            {ind.name}
                            {ind.role === 'trigger' ? '·触发' : ''}
                          </span>
                          <span className="text-dark-400 truncate">{ind.stateText}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-dark-500 text-[10px] mt-1.5 leading-relaxed">{data.realtimeSignal.evidenceText}</p>
                </div>
              )}

              {/* 结论区 */}
              <div className={`rounded-lg border p-3.5 ${bias.badge.replace('text-', 'border-').replace(/bg-\S+/, (m) => m.replace('/15', '/10'))}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className={`font-semibold ${bias.text} leading-snug`}>
                      {data.narrative?.headline ||
                        (data.realtimeSignal?.active
                          ? data.realtimeSignal.dir === 'long'
                            ? '信号触发 · 做多预案生效'
                            : '信号触发 · 做空预案生效'
                          : '无信号 · 结构观望')}
                    </p>
                    <p className="text-dark-400 text-xs mt-1.5">
                      现价 <span className="text-dark-200 font-mono">{formatPrice(data.currentPrice)}</span> · 共振 {data.resonanceText}
                    </p>
                  </div>
                </div>
              </div>

              {/* 今日作战计划（任何时候都有：方向 / 回调位 / 最佳进场区） */}
              {data.dailyPlan && (
                <div className="rounded-lg bg-dark-800/40 border border-dark-700/40 p-3.5">
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <span className="text-dark-300 text-xs font-semibold">今日作战计划</span>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        data.dailyPlan.bias === 'long'
                          ? 'text-green-400 border-green-500/30 bg-green-500/10'
                          : 'text-red-400 border-red-500/30 bg-red-500/10'
                      }`}
                    >
                      {data.dailyPlan.bias === 'long' ? '看多 · 等回调低吸' : '看空 · 等反抽高空'}
                    </span>
                  </div>

                  {data.dailyPlan.entryZone ? (
                    <div className="grid grid-cols-3 gap-2 mb-2.5">
                      <div className="rounded-md bg-dark-900/60 border border-dark-700/50 px-2.5 py-2">
                        <p className="text-dark-500 text-[10px] mb-0.5">最佳进场区</p>
                        <p className="text-dark-100 font-mono text-xs leading-tight">
                          {formatPrice(data.dailyPlan.entryZone.low)}–{formatPrice(data.dailyPlan.entryZone.high)}
                        </p>
                        <p className="text-dark-500 text-[10px] mt-0.5 truncate" title={data.dailyPlan.entryZone.methods.join(' + ')}>
                          {data.dailyPlan.entryZone.methods.join('+')}
                        </p>
                      </div>
                      <div className="rounded-md bg-dark-900/60 border border-dark-700/50 px-2.5 py-2">
                        <p className="text-dark-500 text-[10px] mb-0.5">保护位</p>
                        <p className="text-amber-400 font-mono text-xs leading-tight">
                          {data.dailyPlan.stopHint != null ? formatPrice(data.dailyPlan.stopHint) : '—'}
                        </p>
                        <p className="text-dark-500 text-[10px] mt-0.5">区域外沿 −0.6%</p>
                      </div>
                      <div className="rounded-md bg-dark-900/60 border border-dark-700/50 px-2.5 py-2">
                        <p className="text-dark-500 text-[10px] mb-0.5">距进场区</p>
                        <p className="text-dark-100 font-mono text-xs leading-tight">
                          {data.dailyPlan.bias === 'long'
                            ? ((data.currentPrice / data.dailyPlan.entryZone.high - 1) * 100).toFixed(1)
                            : ((data.dailyPlan.entryZone.low / data.currentPrice - 1) * 100).toFixed(1)}
                          %
                        </p>
                        <p className="text-dark-500 text-[10px] mt-0.5">
                          {data.dailyPlan.bias === 'long' ? '回调幅度' : '反抽幅度'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-dark-500 text-xs mb-2.5">当前无有效进场区（回调位均超 8% 或结构缺失），等信号触发再看预案。</p>
                  )}

                  {data.dailyPlan.pullbackLevels.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {data.dailyPlan.pullbackLevels.map((p, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-dark-900/60 border border-dark-700/50 text-dark-400"
                        >
                          {p.label} <span className="text-dark-200 font-mono">{formatPrice(p.price)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-dark-500 text-[10px] mt-2">
                    {data.dailyPlan.biasText}；此为结构参考位（非触发信号），激进单到此为止、破保护位离场。
                  </p>
                </div>
              )}

              {/* 交易预案（仅 D 短线 / E 波段，信号触发时出现） */}
              {data.plans.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {data.plans.find((p) => p.id === 'D') &&
                    renderPlan(
                      data.plans.find((p) => p.id === 'D')!,
                      data.narrative?.planDComment ||
                        data.plans.find((p) => p.id === 'D')!.trigger,
                    )}
                  {data.plans.find((p) => p.id === 'E') &&
                    renderPlan(
                      data.plans.find((p) => p.id === 'E')!,
                      data.narrative?.planEComment ||
                        data.plans.find((p) => p.id === 'E')!.trigger,
                    )}
                </div>
              )}

              {/* 结构解读（LLM 文案层 · 手动触发） */}
              <div className="rounded-lg bg-dark-800/40 border border-dark-700/40 p-3.5">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-dark-300 text-xs font-semibold shrink-0">结构解读</span>
                    <span className="text-dark-600 text-[10px] truncate">
                      {data.narrative
                        ? `快照 ${new Date(data.narrativeAt || data.generatedAt).toLocaleTimeString('zh-CN', { hour12: false })} · 数字实时`
                        : '数字由规则引擎实时计算'}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      genNarrative();
                    }}
                    disabled={genLoading}
                    className={`shrink-0 flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                      data.narrative
                        ? 'border-dark-600/60 text-dark-400 hover:text-dark-200 hover:border-dark-500'
                        : 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10'
                    }`}
                    title={data.narrative ? '按最新结构重新生成解读' : '生成 AI 结构解读'}
                  >
                    <svg
                      className={`w-3 h-3 ${genLoading ? 'animate-spin' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d={genLoading ? 'M12 3a9 9 0 109 9' : 'M13 10V3L4 14h7v7l9-11h-7'}
                      />
                    </svg>
                    {genLoading ? '生成中' : data.narrative ? '重新生成' : '生成解读'}
                  </button>
                </div>
                {data.narrative ? (
                  <div className="space-y-2">
                    {data.narrative.paragraphs.map((p, i) => (
                      <p key={i} className="text-dark-300 text-xs leading-relaxed">
                        {p}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="text-dark-500 text-xs leading-relaxed">
                    上方数字与预案为规则引擎实时计算结果；点击「生成解读」调用 AI 生成结构解读文案（按需触发，不自动消耗）。
                  </p>
                )}
              </div>

              {/* 失效条件 */}
              {data.invalidation && (
                <div className="rounded-lg bg-red-500/5 border border-red-500/20 px-3.5 py-2.5 flex items-start gap-2">
                  <span className="text-red-400 text-xs font-bold shrink-0 mt-0.5">失效</span>
                  <p className="text-red-300/90 text-xs leading-relaxed">
                    {data.narrative?.invalidation || data.invalidation.note}
                  </p>
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
