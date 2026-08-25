'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import useSymbolStore from '@/store/symbolStore';
import usePriceStore from '@/store/priceStore';
import { apiGet, apiPost } from '@/shared/api/client';

interface AiAnalysis {
  id: string;
  symbol: string;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
  summary: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  reasoning: string;
  keyLevels: { price: number; type: string; note: string }[] | null;
  meta?: {
    regime: string;
    aPlusChecklist?: Record<string, boolean>;
    atr15m?: number | null;
    evidence?: { dimension: string; data: string; signal: string; note: string }[];
    plans?: {
      name: string; style: string; recommended: boolean;
      entry: number | null; stopLoss: number | null;
      takeProfit1: number | null; takeProfit2: number | null;
      rr1: number | null; rr2: number | null; condition: string;
      entryType?: 'limit_pull' | 'limit_break' | 'market';
      cancelIf?: { price: number; reason: string } | null;
      validFor?: string;
    }[];
    noTradeZone?: { from: number; to: number; reason: string } | null;
    /** 江恩八分位阶梯（服务端客观计算） */
    gann?: {
      swingHigh: number; swingLow: number; rangePct: number;
      positionPct: number; zoneLabel: string;
      levels: { division: string; index: number; price: number; distPct: number; meaning: string }[];
    } | null;
  } | null;
  riskWarning: string | null;
  provider: string;
  model: string;
  createdAt: string;
}

/**
 * 兼容 keyLevels 为 JSON 字符串的历史数据（数据库 TEXT 列直出）
 * 直接 .map() 字符串会抛 TypeError 导致整个面板崩溃
 */
function safeKeyLevels(raw: unknown): { price: number; type: string; note: string }[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

interface HistoryItem {
  id: string;
  direction: string;
  confidence: number;
  summary: string;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  createdAt: string;
}

const directionConfig = {
  long: { label: '做多', color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30', icon: '▲' },
  short: { label: '做空', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', icon: '▼' },
  neutral: { label: '观望', color: 'text-dark-300', bg: 'bg-dark-700/30', border: 'border-dark-600/30', icon: '■' },
};

/** 挂单类型徽章 */
const entryTypeMap: Record<string, { label: string; cls: string }> = {
  limit_pull: { label: '限价回踩', cls: 'text-sky-400 bg-sky-500/10 border-sky-500/30' },
  limit_break: { label: '突破挂单', cls: 'text-violet-400 bg-violet-500/10 border-violet-500/30' },
  market: { label: '市价', cls: 'text-dark-400 bg-dark-800/60 border-dark-700/40' },
};

export default function AiAnalysisPanel() {
  const { symbol, okxId, label } = useSymbolStore();
  const { currentPrice } = usePriceStore();
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showPlanB, setShowPlanB] = useState(false);
  const [copiedPlan, setCopiedPlan] = useState<string | null>(null);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [intervalSec, setIntervalSec] = useState(30); // 默认 30 秒
  const [nextAnalyzeIn, setNextAnalyzeIn] = useState(30); // 倒计时秒数
  const [isAnalyzing, setIsAnalyzing] = useState(false); // 分析中状态（UI 显示）
  const analyzingLockRef = useRef(false); // 防重叠锁（不触发重渲染）
  const triggerAnalysisRef = useRef<((silent?: boolean) => Promise<void>) | null>(null); // 持有最新 triggerAnalysis
  const countdownRef = useRef(30); // 倒计时计数器（独立于 state，避免在 state updater 内触发副作用）

  const fetchAnalysis = useCallback(async (): Promise<AiAnalysis | null> => {
    try {
      const data = await apiGet<{ latest: AiAnalysis | null; history: HistoryItem[]; analysisIntervalSec?: number }>(
        `/api/ai-analysis?symbol=${symbol}`,
      );
      setAnalysis(data.latest ? { ...data.latest, keyLevels: safeKeyLevels(data.latest.keyLevels) } : null);
      setHistory(data.history || []);
      // 从后端读取分析间隔（秒），直接使用
      if (data.analysisIntervalSec && data.analysisIntervalSec > 0) {
        setIntervalSec(data.analysisIntervalSec);
        countdownRef.current = data.analysisIntervalSec;
        setNextAnalyzeIn(data.analysisIntervalSec);
      }
      return data.latest;
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取分析失败');
      return null;
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  /** 触发 AI 分析（带防重叠保护） */
  const triggerAnalysis = useCallback(async (silent = false) => {
    // 防重叠：上一次分析还没完成，跳过
    if (analyzingLockRef.current) return;
    analyzingLockRef.current = true;
    if (!silent) setIsAnalyzing(true); // 静默触发不显示加载旋转图标
    setError('');
    try {
      const result = await apiPost<AiAnalysis>('/api/ai-analysis', {
        symbol,
        okxId,
        label,
        currentPrice: currentPrice > 0 ? currentPrice : undefined,
        // 手动点击「立即分析」绕过服务端冷却强制重新分析；自动/静默触发不传，命中冷却直接复用上次结果
        force: !silent,
      });
      setAnalysis({ ...result, keyLevels: safeKeyLevels(result.keyLevels) });
      // 刷新历史列表
      const data = await apiGet<{ latest: AiAnalysis | null; history: HistoryItem[] }>(
        `/api/ai-analysis?symbol=${symbol}`,
      );
      setHistory(data.history || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析失败');
    } finally {
      analyzingLockRef.current = false;
      setIsAnalyzing(false);
      countdownRef.current = intervalSec; // 重置倒计时计数器
      setNextAnalyzeIn(intervalSec); // 更新 UI 显示
    }
  }, [symbol, okxId, label, currentPrice, intervalSec]);

  // 保持 ref 始终指向最新的 triggerAnalysis（不触发 effect 重运行）
  triggerAnalysisRef.current = triggerAnalysis;

  // 初始加载：获取已有分析 → 如果没有则自动触发
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAnalysis().then((latest) => {
      if (cancelled) return;
      // 没有分析记录且自动模式开启时，立即触发首次分析
      if (!latest && autoAnalyze) {
        triggerAnalysisRef.current?.(true);
      }
    });
    return () => { cancelled = true; };
  }, [fetchAnalysis]); // eslint-disable-line react-hooks/exhaustive-deps

  // 自动定时分析：按配置间隔触发（通过 ref 调用，避免 price 频繁变化重建 timer）
  useEffect(() => {
    if (!autoAnalyze) return;

    // 初始化倒计时
    countdownRef.current = intervalSec;
    setNextAnalyzeIn(intervalSec);

    // 倒计时 — 用 ref 跟踪，state 仅用于 UI 显示
    const timer = setInterval(() => {
      countdownRef.current -= 1;
      if (countdownRef.current <= 0) {
        // 倒计时归零，在 state updater 外触发分析（避免渲染阶段副作用）
        triggerAnalysisRef.current?.(true);
        countdownRef.current = intervalSec;
      }
      setNextAnalyzeIn(countdownRef.current);
    }, 1000);

    return () => clearInterval(timer);
  }, [autoAnalyze, intervalSec]); // 只依赖 autoAnalyze 和 intervalSec，不依赖 triggerAnalysis

  const dir = analysis ? directionConfig[analysis.direction] : null;

  const formatPrice = (p: number | null) => {
    if (p == null) return '-';
    return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  /** 价位距现价百分比（带色） */
  const pctFromPrice = (p: number | null) => {
    if (p == null || currentPrice <= 0) return null;
    const pct = ((p - currentPrice) / currentPrice) * 100;
    return (
      <span className={`text-[10px] ${pct >= 0 ? 'text-red-400/70' : 'text-green-400/70'}`}>
        {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
      </span>
    );
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}小时前`;
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  /** 一键复制挂单信息（可直接粘贴到交易所下单） */
  const copyPlanOrder = async (p: NonNullable<NonNullable<AiAnalysis['meta']>['plans']>[number]) => {
    if (!analysis) return;
    const dirText = analysis.direction === 'long' ? '做多' : analysis.direction === 'short' ? '做空' : '';
    const etText = p.entryType === 'limit_break' ? '突破挂单' : p.entryType === 'market' ? '市价' : '限价';
    const parts = [
      `${label} ${etText}${dirText}`,
      p.entry != null ? `挂单价 ${p.entry}` : null,
      p.stopLoss != null ? `止损 ${p.stopLoss}` : null,
      p.takeProfit1 != null ? `止盈1 ${p.takeProfit1}` : null,
      p.takeProfit2 != null ? `止盈2 ${p.takeProfit2}` : null,
      p.cancelIf ? `撤单价 ${p.cancelIf.price}` : null,
    ].filter(Boolean).join(' | ');
    try {
      await navigator.clipboard.writeText(parts);
      setCopiedPlan(p.name);
      setTimeout(() => setCopiedPlan(null), 1500);
    } catch {}
  };

  const plans = analysis?.meta?.plans || [];
  const planA = plans.find((p) => p.recommended) || plans[0] || null;
  const planB = plans.find((p) => p !== planA) || null;
  const gann = analysis?.meta?.gann || null;
  const inNoTradeZone = !!(
    analysis?.meta?.noTradeZone &&
    currentPrice >= analysis.meta.noTradeZone.from &&
    currentPrice <= analysis.meta.noTradeZone.to
  );

  /** 挂单指令卡（纯数字结果） */
  const OrderCard = ({ p }: { p: NonNullable<NonNullable<AiAnalysis['meta']>['plans']>[number] }) => {
    const isLong = analysis?.direction === 'long';
    const accent = p.recommended ? (isLong ? 'border-green-500/40 bg-green-500/5' : 'border-red-500/40 bg-red-500/5') : 'border-dark-800 bg-dark-900/40';
    return (
      <div className={`rounded-xl border ${accent} p-3.5`}>
        {/* 第一行：挂单价（大） + 类型 + 复制 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-baseline gap-2">
            <span className="text-dark-500 text-xs">{dir?.label}</span>
            <span className="text-white text-2xl font-bold tracking-tight">{p.entry != null ? formatPrice(p.entry) : '--'}</span>
            {pctFromPrice(p.entry)}
          </div>
          <div className="flex items-center gap-1.5">
            {p.entryType && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${entryTypeMap[p.entryType]?.cls || ''}`}>
                {entryTypeMap[p.entryType]?.label}
              </span>
            )}
            <button
              onClick={() => copyPlanOrder(p)}
              className={`text-[10px] px-2.5 py-1 rounded-md border font-medium transition-colors ${
                copiedPlan === p.name
                  ? 'text-green-400 border-green-500/40 bg-green-500/10'
                  : 'text-blue-400 border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20'
              }`}
            >
              {copiedPlan === p.name ? '✓ 已复制' : '复制挂单'}
            </button>
          </div>
        </div>

        {/* 第二行：止损 / 止盈1 / 止盈2 / 盈亏比 */}
        <div className="grid grid-cols-4 gap-2 mb-2.5">
          <div className="rounded-lg bg-red-500/8 border border-red-500/20 py-1.5 text-center">
            <div className="text-dark-500 text-[10px]">止损</div>
            <div className="text-red-400 text-sm font-semibold">{formatPrice(p.stopLoss)}</div>
            {pctFromPrice(p.stopLoss)}
          </div>
          <div className="rounded-lg bg-green-500/8 border border-green-500/20 py-1.5 text-center">
            <div className="text-dark-500 text-[10px]">止盈 1</div>
            <div className="text-green-400 text-sm font-semibold">{formatPrice(p.takeProfit1)}</div>
            {pctFromPrice(p.takeProfit1)}
          </div>
          <div className="rounded-lg bg-green-500/8 border border-green-500/20 py-1.5 text-center">
            <div className="text-dark-500 text-[10px]">止盈 2</div>
            <div className="text-green-400 text-sm font-semibold">{formatPrice(p.takeProfit2)}</div>
            {pctFromPrice(p.takeProfit2)}
          </div>
          <div className="rounded-lg bg-dark-800/60 border border-dark-700/40 py-1.5 text-center">
            <div className="text-dark-500 text-[10px]">盈亏比</div>
            <div className="text-white text-sm font-semibold">
              {p.rr1 != null ? `1:${p.rr1}` : '--'}
            </div>
            {p.rr2 != null ? <div className="text-dark-500 text-[10px]">→ {p.rr2}</div> : null}
          </div>
        </div>

        {/* 第三行：撤单价（只显示数字） */}
        {p.cancelIf && p.cancelIf.price > 0 && (
          <div className="flex items-center justify-center gap-2 py-1.5 rounded-lg bg-dark-900/60 border border-dark-800">
            <span className="text-dark-500 text-[11px]">撤单价</span>
            <span className="text-amber-400 text-sm font-semibold">{formatPrice(p.cancelIf.price)}</span>
            {pctFromPrice(p.cancelIf.price)}
            <span className="text-dark-600 text-[10px]">越过即撤</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="glass-card p-5">
      {/* ===== 顶部操作栏 ===== */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <span className={`text-lg ${dir ? dir.color : 'text-blue-400'}`}>⚡</span>
          <h2 className="text-base font-semibold text-white">AI 挂单信号</h2>
          <span className="text-xs text-dark-500">{label}</span>
          {autoAnalyze && (
            <span className="flex items-center gap-1 text-xs">
              {isAnalyzing ? (
                <span className="flex items-center gap-1 text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                  分析中
                </span>
              ) : (
                <span className="text-dark-500">{nextAnalyzeIn}s</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoAnalyze(!autoAnalyze)}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              autoAnalyze
                ? 'bg-green-600/20 text-green-400 border border-green-500/30'
                : 'bg-dark-800 text-dark-400 border border-dark-700'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoAnalyze ? 'bg-green-400 animate-pulse' : 'bg-dark-500'}`} />
            {autoAnalyze ? '自动' : '手动'}
          </button>
          <button
            onClick={() => triggerAnalysis(false)}
            disabled={isAnalyzing}
            className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isAnalyzing ? (
              <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            立即分析
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm mb-4">
          {error}
        </div>
      )}

      {/* 加载中 */}
      {loading && !analysis && (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* 无分析结果 */}
      {!loading && !analysis && !error && (
        <div className="text-center py-12 text-dark-400">
          <p className="text-sm">暂无分析记录</p>
          <p className="text-xs text-dark-500 mt-1">点击「立即分析」获取挂单信号</p>
        </div>
      )}

      {/* ===== 结果区（只看结果） ===== */}
      {analysis && dir && (
        <div className="space-y-3.5">
          {/* 结果头：方向 + 置信度 + 现价 */}
          <div className="flex items-stretch gap-2.5">
            <div className={`flex-1 rounded-xl border ${dir.border} ${dir.bg} px-4 py-3 flex items-center justify-between`}>
              <div>
                <div className="text-dark-500 text-[10px] mb-0.5">方向</div>
                <div className={`text-2xl font-bold leading-none ${dir.color}`}>
                  {dir.icon} {dir.label}
                </div>
              </div>
              <div className="text-right">
                <div className="text-dark-500 text-[10px] mb-0.5">置信度</div>
                <div className={`text-2xl font-bold leading-none ${dir.color}`}>{analysis.confidence}</div>
              </div>
            </div>
            <div className="rounded-xl border border-dark-700/60 bg-dark-800/40 px-4 py-3 flex flex-col justify-center min-w-[110px]">
              <div className="text-dark-500 text-[10px] mb-0.5">现价</div>
              <div className="text-white text-lg font-semibold leading-none">{formatPrice(currentPrice)}</div>
              <div className="text-dark-600 text-[10px] mt-1">{formatTime(analysis.createdAt)}</div>
            </div>
          </div>

          {/* 不做区警示（当前处于观望区 = 行动指令） */}
          {inNoTradeZone && analysis.meta?.noTradeZone && (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/40">
              <span className="text-amber-400">⛔</span>
              <span className="text-xs text-amber-400 font-medium">
                不做区 {formatPrice(analysis.meta.noTradeZone.from)} ~ {formatPrice(analysis.meta.noTradeZone.to)} — 观望
              </span>
            </div>
          )}

          {/* 挂单指令卡（Plan A） */}
          {planA && analysis.direction !== 'neutral' && (
            <OrderCard p={planA} />
          )}

          {/* 观望时的提示（neutral = 结果本身） */}
          {analysis.direction === 'neutral' && (
            <div className="p-4 rounded-xl border border-dark-700 bg-dark-800/40 text-center">
              <div className="text-dark-300 text-sm">当前无挂单信号</div>
              <div className="text-dark-500 text-xs mt-1">等待下一次分析或参考下方八分位</div>
            </div>
          )}

          {/* Plan B 折叠 */}
          {planB && analysis.direction !== 'neutral' && (
            <div>
              <button
                onClick={() => setShowPlanB(!showPlanB)}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-dark-800/40 border border-dark-800 text-dark-400 text-xs hover:text-white transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${showPlanB ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                激进备选 Plan B
              </button>
              {showPlanB && (
                <div className="mt-2">
                  <OrderCard p={planB} />
                </div>
              )}
            </div>
          )}

          {/* 江恩八分位阶梯（纯点位结果） */}
          {gann && (() => {
            const sorted = [...gann.levels].sort((a, b) => b.price - a.price); // 8/8 → 1/8
            return (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-dark-400 text-xs font-medium">八分位</span>
                  <span className="text-[10px] text-dark-500">
                    {formatPrice(gann.swingLow)} ~ {formatPrice(gann.swingHigh)} · 位置 {gann.positionPct}%
                  </span>
                </div>
                {/* 位置条 */}
                <div className="relative h-1.5 rounded-full bg-gradient-to-r from-green-500/40 via-dark-600 to-red-500/40 mb-2">
                  {[12.5, 25, 37.5, 50, 62.5, 75, 87.5].map((pct) => (
                    <div key={pct} className="absolute top-0 h-1.5 w-px bg-dark-900/80" style={{ left: `${pct}%` }} />
                  ))}
                  {currentPrice > 0 && (
                    <div
                      className="absolute -top-1 h-3.5 w-1 bg-white rounded-sm"
                      style={{ left: `calc(${Math.min(Math.max(gann.positionPct, 0), 100)}% - 2px)` }}
                    />
                  )}
                </div>
                {/* 8 档紧凑列表 */}
                <div className="space-y-0.5">
                  {sorted.map((l) => {
                    const isRes = currentPrice > 0 && l.price > currentPrice;
                    const isAxis = l.index === 4;
                    return (
                      <div
                        key={l.index}
                        className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                          isAxis ? 'bg-amber-500/10 border border-amber-500/25' : ''
                        }`}
                      >
                        <span className={`w-7 text-[10px] font-bold ${isAxis ? 'text-amber-400' : isRes ? 'text-red-400/80' : 'text-green-400/80'}`}>
                          {l.division}
                        </span>
                        <span className="text-white/90 font-medium">{formatPrice(l.price)}</span>
                        <span className={`text-[10px] ${l.distPct >= 0 ? 'text-red-400/60' : 'text-green-400/60'}`}>
                          {l.distPct > 0 ? '+' : ''}{l.distPct}%
                        </span>
                        {isAxis && <span className="text-amber-400/60 text-[10px] ml-auto">中轴</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* 历史（极简折叠：方向 + 挂单价 + 止损 + 时间） */}
          {history.length > 1 && (
            <div>
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-xs text-dark-500 hover:text-white transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${showHistory ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                历史 ({history.length})
              </button>
              {showHistory && (
                <div className="mt-2 space-y-1 max-h-44 overflow-y-auto">
                  {history.map((item) => {
                    const hDir = directionConfig[item.direction as keyof typeof directionConfig] || directionConfig.neutral;
                    return (
                      <div key={item.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg bg-dark-900/40 border border-dark-800/50 text-xs">
                        <span className={`font-bold ${hDir.color} w-16 flex-shrink-0`}>{hDir.icon} {hDir.label}</span>
                        <span className="text-dark-500">{item.confidence}%</span>
                        <span className="text-white/80">{item.entryPrice != null ? formatPrice(item.entryPrice) : '--'}</span>
                        <span className="text-red-400/70">{item.stopLoss != null ? `止损 ${formatPrice(item.stopLoss)}` : ''}</span>
                        <span className="text-dark-600 ml-auto flex-shrink-0">{formatTime(item.createdAt)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
