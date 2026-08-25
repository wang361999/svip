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
  neutral: { label: '观望', color: 'text-dark-300', bg: 'bg-dark-700/30', border: 'border-dark-600/30', icon: '●' },
};

export default function AiAnalysisPanel() {
  const { symbol, okxId, label } = useSymbolStore();
  const { currentPrice } = usePriceStore();
  const [analysis, setAnalysis] = useState<AiAnalysis | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showReasoning, setShowReasoning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
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

  // 挂单类型徽章
  const entryTypeMap: Record<string, { label: string; cls: string }> = {
    limit_pull: { label: '限价回踩', cls: 'text-sky-400 bg-sky-500/10 border-sky-500/30' },
    limit_break: { label: '突破挂单', cls: 'text-violet-400 bg-violet-500/10 border-violet-500/30' },
    market: { label: '市价', cls: 'text-dark-400 bg-dark-800/60 border-dark-700/40' },
  };

  /** 一键复制挂单信息（可直接粘贴到交易所下单） */
  const copyPlanOrder = async (p: {
    name: string;
    entryType?: string;
    entry: number | null;
    stopLoss: number | null;
    takeProfit1: number | null;
    takeProfit2: number | null;
    cancelIf?: { price: number; reason: string } | null;
    validFor?: string;
  }) => {
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
      p.validFor || null,
    ].filter(Boolean).join(' | ');
    try {
      await navigator.clipboard.writeText(parts);
      setCopiedPlan(p.name);
      setTimeout(() => setCopiedPlan(null), 1500);
    } catch {}
  };

  return (
    <div className="glass-card p-5">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <h2 className="text-lg font-semibold text-white">AI 行情分析</h2>
          <span className="text-xs text-dark-500">{label}</span>
          {/* 自动分析状态 */}
          {autoAnalyze && (
            <span className="flex items-center gap-1 text-xs">
              {isAnalyzing ? (
                <span className="flex items-center gap-1 text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-ping" />
                  AI 分析中...
                </span>
              ) : (
                <span className="flex items-center gap-1 text-green-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  下次分析 {nextAnalyzeIn}s
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 自动/手动切换 */}
          <button
            onClick={() => setAutoAnalyze(!autoAnalyze)}
            className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
              autoAnalyze
                ? 'bg-green-600/20 text-green-400 border border-green-500/30'
                : 'bg-dark-800 text-dark-400 border border-dark-700'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${autoAnalyze ? 'bg-green-400 animate-pulse' : 'bg-dark-500'}`} />
            {autoAnalyze ? '自动' : '手动'}
          </button>
          {/* 手动触发按钮 */}
          <button
            onClick={() => triggerAnalysis(false)}
            disabled={isAnalyzing}
            className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isAnalyzing ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                分析中...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                立即分析
              </>
            )}
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
          <svg className="w-12 h-12 mx-auto mb-3 text-dark-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <p className="text-sm">暂无 AI 分析记录</p>
          <p className="text-xs text-dark-500 mt-1">点击「立即分析」获取 AI 对当前行情的智能分析</p>
        </div>
      )}

      {/* 分析结果 */}
      {analysis && dir && (
        <div className="space-y-4">
          {/* 方向和置信度 */}
          <div className={`p-4 rounded-lg ${dir.bg} border ${dir.border}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-2xl ${dir.color}`}>{dir.icon}</span>
                <div>
                  <span className={`text-xl font-bold ${dir.color}`}>{dir.label}</span>
                  <span className="text-dark-500 text-sm ml-2">{analysis.provider} / {analysis.model}</span>
                </div>
              </div>
              <div className="text-right">
                <div className="text-dark-400 text-xs">置信度</div>
                <div className={`text-2xl font-bold ${dir.color}`}>{analysis.confidence}%</div>
              </div>
            </div>
            {/* 置信度进度条 */}
            <div className="w-full h-1.5 bg-dark-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  analysis.direction === 'long' ? 'bg-green-500'
                  : analysis.direction === 'short' ? 'bg-red-500'
                  : 'bg-dark-500'
                }`}
                style={{ width: `${analysis.confidence}%` }}
              />
            </div>
          </div>

          {/* 总结 */}
          <div>
            <p className="text-dark-300 text-sm leading-relaxed">{analysis.summary}</p>
          </div>

          {/* 多维证据表（大神框架核心：每条证据带数值与多空倾向） */}
          {analysis.meta?.evidence && analysis.meta.evidence.length > 0 && (
            <div>
              <div className="text-dark-400 text-xs font-medium mb-2">
                多维证据表
                <span className="ml-2 text-dark-600 font-normal">
                  {(() => {
                    const ev = analysis.meta!.evidence!;
                    const b = ev.filter((e) => e.signal === 'bullish').length;
                    const s = ev.filter((e) => e.signal === 'bearish').length;
                    return `${b} 利多 / ${s} 利空 / ${ev.length - b - s} 中性`;
                  })()}
                </span>
              </div>
              <div className="space-y-1">
                {analysis.meta.evidence.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-dark-900/40 border border-dark-800/50">
                    <span className="w-3 flex-shrink-0">
                      {e.signal === 'bullish' ? '▲' : e.signal === 'bearish' ? '▼' : '●'}
                    </span>
                    <span className={`w-3 flex-shrink-0 ${
                      e.signal === 'bullish' ? 'text-green-400' : e.signal === 'bearish' ? 'text-red-400' : 'text-dark-500'
                    }`} />
                    <span className="text-dark-300 w-24 flex-shrink-0 truncate" title={e.dimension}>{e.dimension}</span>
                    <span className="text-white flex-shrink-0 max-w-[38%] truncate" title={e.data}>{e.data}</span>
                    <span className="text-dark-500 flex-1 truncate" title={e.note}>{e.note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 市场状态 + A+ 清单（大神思维核心） */}
          {analysis.meta && analysis.meta.regime && (
            <div className="flex flex-wrap items-center gap-2">
              {(() => {
                const rc: Record<string, { label: string; cls: string }> = {
                  trending: { label: '⚡ 趋势日', cls: 'text-blue-400 bg-blue-500/10 border-blue-500/30' },
                  range: { label: '⇄ 区间日', cls: 'text-purple-400 bg-purple-500/10 border-purple-500/30' },
                  chop: { label: '✕ 碎波日（禁开仓）', cls: 'text-dark-300 bg-dark-700/40 border-dark-600/40' },
                  event: { label: '⚡ 事件日', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
                };
                const cfg = rc[analysis.meta.regime] || rc.chop;
                return <span className={`text-xs px-2 py-1 rounded border ${cfg.cls}`}>{cfg.label}</span>;
              })()}
              {analysis.meta.aPlusChecklist && (
                <>
                  {[
                    ['regimeClear', '状态明确'],
                    ['timeframeAligned', '多周期共振'],
                    ['fundingNotExtreme', '费率不极端'],
                    ['volumeConfirmed', '量能配合'],
                    ['nearInvalidation', '贴近无效点'],
                  ].map(([key, name]) => {
                    const ok = Boolean((analysis.meta!.aPlusChecklist as Record<string, boolean>)[key]);
                    return (
                      <span
                        key={key}
                        className={`text-[11px] px-1.5 py-0.5 rounded border ${
                          ok
                            ? 'text-green-400 bg-green-500/10 border-green-500/25'
                            : 'text-dark-500 bg-dark-800/40 border-dark-700/30 line-through'
                        }`}
                      >
                        {ok ? '✓' : '✕'} {name}
                      </span>
                    );
                  })}
                </>
              )}
              {analysis.meta.atr15m != null && analysis.meta.atr15m > 0 && (
                <span className="text-[11px] text-dark-500 px-1.5 py-0.5">
                  15m ATR: {analysis.meta.atr15m.toFixed(2)}
                </span>
              )}
            </div>
          )}

          {/* 关键价位 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-dark-800/40 rounded-lg p-3 border border-dark-700/30">
              <div className="text-dark-500 text-xs mb-1">入场价</div>
              <div className="text-white font-semibold text-sm">{formatPrice(analysis.entryPrice)}</div>
            </div>
            <div className="bg-dark-800/40 rounded-lg p-3 border border-dark-700/30">
              <div className="text-dark-500 text-xs mb-1">止损</div>
              <div className="text-red-400 font-semibold text-sm">{formatPrice(analysis.stopLoss)}</div>
            </div>
            <div className="bg-dark-800/40 rounded-lg p-3 border border-dark-700/30">
              <div className="text-dark-500 text-xs mb-1">止盈1</div>
              <div className="text-green-400 font-semibold text-sm">{formatPrice(analysis.takeProfit1)}</div>
            </div>
            <div className="bg-dark-800/40 rounded-lg p-3 border border-dark-700/30">
              <div className="text-dark-500 text-xs mb-1">止盈2</div>
              <div className="text-green-400 font-semibold text-sm">{formatPrice(analysis.takeProfit2)}</div>
            </div>
          </div>

          {/* 盈亏比计算 */}
          {analysis.entryPrice && analysis.stopLoss && analysis.takeProfit1 && (
            <div className="text-xs text-dark-400 flex items-center gap-4">
              <span>风险: <span className="text-red-400">{Math.abs(analysis.entryPrice - analysis.stopLoss).toFixed(2)}</span></span>
              <span>收益1: <span className="text-green-400">{Math.abs(analysis.takeProfit1 - analysis.entryPrice).toFixed(2)}</span></span>
              <span>盈亏比: <span className="text-blue-400 font-medium">
                {Math.abs(analysis.takeProfit1 - analysis.entryPrice) / Math.abs(analysis.entryPrice - analysis.stopLoss) > 0
                  ? (Math.abs(analysis.takeProfit1 - analysis.entryPrice) / Math.abs(analysis.entryPrice - analysis.stopLoss)).toFixed(2)
                  : '-'}
                :1
              </span></span>
            </div>
          )}

          {/* 关键价位列表 */}
          {analysis.keyLevels && analysis.keyLevels.length > 0 && (
            <div>
              <div className="text-dark-400 text-xs font-medium mb-2">关键价位</div>
              <div className="flex flex-wrap gap-2">
                {analysis.keyLevels.map((level, i) => (
                  <div key={i} className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-dark-800/60 border border-dark-700/30">
                    <span className={String(level.type).includes('支撑') ? 'text-green-400' : String(level.type).includes('阻力') ? 'text-red-400' : 'text-dark-300'}>
                      {level.type}
                    </span>
                    <span className="text-white font-medium">{formatPrice(Number(level.price))}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 挂单计划：A 推荐 / B 激进（挂单执行框架） */}
          {analysis.meta?.plans && analysis.meta.plans.length > 0 && (
            <div>
              <div className="text-dark-400 text-xs font-medium mb-2">挂单计划</div>
              <div className="space-y-2">
                {analysis.meta.plans.map((p, i) => (
                  <div
                    key={i}
                    className={`p-2.5 rounded-lg border ${
                      p.recommended
                        ? 'bg-green-500/5 border-green-500/30'
                        : 'bg-dark-900/40 border-dark-800'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                          p.recommended ? 'bg-green-500/20 text-green-400' : 'bg-dark-800 text-dark-400'
                        }`}>
                          Plan {p.name}
                        </span>
                        <span className="text-dark-300 text-xs truncate">{p.style}</span>
                        {p.entryType && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${entryTypeMap[p.entryType]?.cls || ''}`}>
                            {entryTypeMap[p.entryType]?.label || p.entryType}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {p.recommended && (
                          <span className="text-[10px] text-green-400 font-medium">推荐</span>
                        )}
                        <button
                          onClick={() => copyPlanOrder(p)}
                          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                            copiedPlan === p.name
                              ? 'text-green-400 border-green-500/40 bg-green-500/10'
                              : 'text-dark-400 border-dark-700 bg-dark-900/60 hover:text-white hover:border-dark-500'
                          }`}
                        >
                          {copiedPlan === p.name ? '已复制' : '复制挂单'}
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-5 gap-1.5 text-center mb-1.5">
                      <div>
                        <div className="text-dark-600 text-[10px]">挂单价</div>
                        <div className="text-white text-xs font-semibold">{p.entry != null ? formatPrice(p.entry) : '--'}</div>
                        {p.entry != null && currentPrice > 0 && (
                          <div className={`text-[9px] ${p.entry < currentPrice ? 'text-sky-500' : 'text-violet-500'}`}>
                            {(((p.entry - currentPrice) / currentPrice) * 100).toFixed(2)}%
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-dark-600 text-[10px]">止损</div>
                        <div className="text-red-400 text-xs font-medium">{p.stopLoss != null ? formatPrice(p.stopLoss) : '--'}</div>
                      </div>
                      <div>
                        <div className="text-dark-600 text-[10px]">止盈1</div>
                        <div className="text-green-400 text-xs font-medium">{p.takeProfit1 != null ? formatPrice(p.takeProfit1) : '--'}</div>
                      </div>
                      <div>
                        <div className="text-dark-600 text-[10px]">止盈2</div>
                        <div className="text-green-400 text-xs font-medium">{p.takeProfit2 != null ? formatPrice(p.takeProfit2) : '--'}</div>
                      </div>
                      <div>
                        <div className="text-dark-600 text-[10px]">盈亏比</div>
                        <div className="text-white text-xs font-medium">
                          {p.rr1 != null ? `1:${p.rr1}` : '--'}
                          {p.rr2 != null ? <span className="text-dark-500"> / {p.rr2}</span> : null}
                        </div>
                      </div>
                    </div>
                    {p.cancelIf && (
                      <div className="flex items-start gap-1.5 text-[11px] leading-relaxed mb-1">
                        <span className="text-red-400/90 flex-shrink-0">撤单条件：</span>
                        <span className="text-dark-400">
                          价格越过 <span className="text-red-400 font-semibold">{formatPrice(p.cancelIf.price)}</span>
                          {p.cancelIf.reason ? ` — ${p.cancelIf.reason}` : '（错过即撤，禁止追单）'}
                        </span>
                      </div>
                    )}
                    <div className="flex items-start gap-1.5 text-[11px] leading-relaxed flex-wrap">
                      {p.validFor && (
                        <span className="text-dark-500">有效期：{p.validFor}</span>
                      )}
                      {p.condition && (
                        <span className="text-dark-400">成交前提：{p.condition}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 不做区（盈亏比最差的观望区间） */}
          {analysis.meta?.noTradeZone && currentPrice >= analysis.meta.noTradeZone.from && currentPrice <= analysis.meta.noTradeZone.to ? (
            <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/40">
              <svg className="w-4 h-4 text-amber-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div className="text-xs">
                <span className="text-amber-400 font-medium">
                  当前处于不做区（{formatPrice(analysis.meta.noTradeZone.from)} ~ {formatPrice(analysis.meta.noTradeZone.to)}）
                </span>
                <span className="text-dark-400"> — {analysis.meta.noTradeZone.reason}，建议观望</span>
              </div>
            </div>
          ) : null}

          {/* 风险提示 */}
          {analysis.riskWarning && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
              <svg className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="text-amber-400/80 text-xs">{analysis.riskWarning}</span>
            </div>
          )}

          {/* 详细分析 */}
          <div>
            <button
              onClick={() => setShowReasoning(!showReasoning)}
              className="flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <svg className={`w-4 h-4 transition-transform ${showReasoning ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              详细分析逻辑
            </button>
            {showReasoning && (
              <div className="mt-2 p-3 rounded-lg bg-dark-900/60 border border-dark-800">
                <p className="text-dark-300 text-sm leading-relaxed whitespace-pre-wrap">{analysis.reasoning}</p>
              </div>
            )}
          </div>

          {/* 时间和模型信息 */}
          <div className="flex items-center justify-between text-xs text-dark-500 pt-2 border-t border-dark-800">
            <span>分析时间: {formatTime(analysis.createdAt)}</span>
            <span>模型: {analysis.provider} / {analysis.model}</span>
          </div>

          {/* 历史记录 */}
          {history.length > 1 && (
            <div>
              <button
                onClick={() => setShowHistory(!showHistory)}
                className="flex items-center gap-1 text-sm text-dark-400 hover:text-white transition-colors"
              >
                <svg className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                历史记录 ({history.length})
              </button>
              {showHistory && (
                <div className="mt-2 space-y-2 max-h-48 overflow-y-auto">
                  {history.map((item) => {
                    const hDir = directionConfig[item.direction as keyof typeof directionConfig] || directionConfig.neutral;
                    return (
                      <div key={item.id} className="flex items-center gap-3 p-2 rounded-lg bg-dark-900/40 border border-dark-800/50">
                        <span className={`text-sm font-medium ${hDir.color}`}>{hDir.icon} {hDir.label}</span>
                        <span className="text-dark-500 text-xs">{item.confidence}%</span>
                        <span className="text-dark-400 text-xs flex-1 truncate">{item.summary}</span>
                        <span className="text-dark-500 text-xs flex-shrink-0">{formatTime(item.createdAt)}</span>
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
