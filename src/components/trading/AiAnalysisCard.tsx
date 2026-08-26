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
  id: 'A' | 'B';
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
  confidence: 'high' | 'medium';
}

interface KeyLevel {
  price: number;
  label: string;
  distancePct: number;
}

interface Narrative {
  headline: string;
  biasText: string;
  paragraphs: string[];
  planAComment: string;
  planBComment: string;
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
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                isLong ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}
            >
              {plan.id}
            </span>
            <span className="text-white text-sm font-semibold">{plan.name}</span>
          </div>
          <span className={`text-xs ${isLong ? 'text-green-400' : 'text-red-400'}`}>
            {isLong ? '做多' : '做空'}
          </span>
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
              {formatPrice(plan.tp1)} <span className="text-dark-500">({plan.rrTp1})</span>
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-dark-400">TP2</span>
            <span className="text-green-400 font-mono">
              {formatPrice(plan.tp2)} <span className="text-dark-500">({plan.rrTp2})</span>
            </span>
          </div>
        </div>
        <div className="mt-2 pt-2 border-t border-dark-700/50 flex items-center justify-between text-xs">
          <span className="text-dark-400">
            风险 <span className="text-dark-300 font-mono">{plan.riskPct}%</span>
          </span>
          <span className="text-dark-400">
            加权盈亏比 <span className="text-amber-400 font-mono font-semibold">{plan.rrBlended}</span>
          </span>
        </div>
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

              {/* 双预案 */}
              {data.plans.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {renderPlan(
                    data.plans[0],
                    data.narrative?.planAComment || data.plans[0].trigger,
                  )}
                  {data.plans[1] &&
                    renderPlan(data.plans[1], data.narrative?.planBComment || data.plans[1].trigger)}
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
