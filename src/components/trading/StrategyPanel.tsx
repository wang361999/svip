'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { fetchKlines } from '@/shared/lib/market-data';
import {
  computeAllSignals,
  summarizeSignals,
  normalizeStrategyConfig,
  type StrategyConfig,
  type StrategySignal,
} from '@/shared/lib/strategies';
import useAuthStore from '@/store/authStore';
import useSymbolStore from '@/store/symbolStore';
import usePriceStore from '@/store/priceStore';
import { apiGet } from '@/shared/api/client';

function fp(n?: number): string {
  if (!n || n === 0) return '--';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function StrategyPanel() {
  const isMember = useAuthStore((s) => s.isMember);
  const { symbol, okxId } = useSymbolStore();
  const currentPrice = usePriceStore((s) => s.currentPrice);

  const [config, setConfig] = useState<StrategyConfig>({});
  const [signals, setSignals] = useState<StrategySignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const klinesCache = useRef<{ k15m: any[]; k1h: any[]; k4h: any[] }>({ k15m: [], k1h: [], k4h: [] });

  // 加载用户策略配置
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<StrategyConfig>('/api/user/strategy');
        if (!cancelled) setConfig(normalizeStrategyConfig(data));
      } catch (err: any) {
        if (!cancelled) setError(err?.message || '加载策略配置失败');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 计算信号
  const compute = useCallback(async () => {
    try {
      const [k15m, k1h, k4h] = await Promise.all([
        fetchKlines(symbol, okxId, '15m'),
        fetchKlines(symbol, okxId, '1h').catch(() => []),
        fetchKlines(symbol, okxId, '4h').catch(() => []),
      ]);
      klinesCache.current = { k15m, k1h, k4h };
      const price = currentPrice || (k15m[k15m.length - 1]?.close ?? 0);
      const sigs = computeAllSignals(config, {
        k15m,
        k1h,
        k4h,
        currentPrice: price,
      });
      setSignals(sigs);
      setError('');
    } catch (err: any) {
      setError(err?.message || '计算信号失败');
    } finally {
      setLoading(false);
    }
  }, [symbol, okxId, currentPrice, config]);

  useEffect(() => {
    if (Object.keys(config).length === 0) return;
    compute();
    const timer = setInterval(compute, 30000);
    return () => clearInterval(timer);
  }, [compute, config]);

  const summary = summarizeSignals(signals);
  const enabledCount = Object.values(config).filter((c) => c?.enabled).length;
  const triggeredSignals = signals.filter((s) => s.triggered);

  // 非会员引导
  if (!isMember && !loading) {
    return (
      <div className="glass-card p-4 space-y-3">
        <div className="flex items-center justify-between border-b border-dark-700/30 pb-2.5">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-md bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <div>
              <h3 className="text-white font-bold text-sm tracking-wide">合约策略面板</h3>
              <span className="text-[10px] text-dark-500">{symbol} · 16 套策略</span>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-500/5 to-dark-900/40 p-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            <span className="text-amber-400 font-semibold text-sm">开通 VIP 解锁合约策略面板</span>
          </div>
          <p className="text-dark-400 text-xs leading-relaxed mb-3">
            8 套专业 BTC/ETH 合约策略 · 实时信号 · 进出场价位 · 多策略共振
          </p>
          <a href="/profile" className="inline-block px-4 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-medium hover:bg-amber-500/20 transition-all">
            立即开通 →
          </a>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="glass-card p-4">
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // 未启用任何策略时整个面板自动隐藏（与引擎「全关 = 不开仓」的行为保持一致）
  // 例外：配置加载失败时保留面板以展示错误信息，避免静默消失
  if (enabledCount === 0 && !error) {
    return null;
  }

  return (
    <div className="glass-card p-4 space-y-3">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-dark-700/30 pb-2.5">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <div>
            <h3 className="text-white font-bold text-sm tracking-wide">合约策略面板</h3>
            <span className="text-[10px] text-dark-500">
              {symbol} · {enabledCount}/{signals.length || enabledCount} 策略运行
            </span>
          </div>
        </div>
        <a
          href="/strategies"
          className="text-[10px] px-2 py-1 rounded-md bg-dark-800 hover:bg-dark-700 text-dark-300 hover:text-white border border-dark-600 transition-colors flex items-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          策略配置
        </a>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* 综合建议 */}
      {enabledCount > 0 && signals.length > 0 && (
        <div className={`rounded-xl border p-3 ${
          summary.direction === 'long'
            ? 'border-green-500/30 bg-green-500/5'
            : summary.direction === 'short'
              ? 'border-red-500/30 bg-red-500/5'
              : 'border-dark-600/40 bg-dark-800/40'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${
                summary.direction === 'long' ? 'bg-green-400 animate-pulse'
                  : summary.direction === 'short' ? 'bg-red-400 animate-pulse'
                  : 'bg-slate-400'
              }`} />
              <span className={`text-sm font-bold ${
                summary.direction === 'long' ? 'text-green-400'
                  : summary.direction === 'short' ? 'text-red-400'
                  : 'text-slate-400'
              }`}>
                {summary.direction === 'long' ? '综合偏多' : summary.direction === 'short' ? '综合偏空' : '综合中性'}
              </span>
              {summary.triggeredCount > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
                  {summary.triggeredCount} 个已触发
                </span>
              )}
            </div>
            <span className="text-[10px] text-dark-400">
              置信度 <span className="text-white font-bold">{summary.confidence}%</span>
            </span>
          </div>
          <p className="text-[11px] text-dark-400 mt-1.5">{summary.text}</p>
        </div>
      )}

      {/* 已触发信号（优先展示） */}
      {triggeredSignals.length > 0 && (
        <div className="space-y-2">
          {triggeredSignals.map((sig) => (
            <SignalCard key={sig.strategyId} signal={sig} highlight />
          ))}
        </div>
      )}

      {/* 其他运行中的策略 */}
      {signals.filter((s) => !s.triggered).length > 0 && (
        <details className="group">
          <summary className="cursor-pointer flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-dark-800/40 transition-colors">
            <span className="text-[11px] text-dark-400">
              运行中策略（{signals.filter((s) => !s.triggered).length}）
            </span>
            <svg className="w-3.5 h-3.5 text-dark-500 group-open:rotate-180 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </summary>
          <div className="mt-2 space-y-2">
            {signals.filter((s) => !s.triggered).map((sig) => (
              <SignalCard key={sig.strategyId} signal={sig} />
            ))}
          </div>
        </details>
      )}

      {/* 底部声明 */}
      <div className="text-center text-dark-600 text-[10px] pt-1">
        信号每 30 秒刷新 · 仅供参考，不构成投资建议
      </div>
    </div>
  );
}

// ==================== 单个信号卡片 ====================

function SignalCard({ signal, highlight = false }: { signal: StrategySignal; highlight?: boolean }) {
  const [expanded, setExpanded] = useState(highlight);
  const isLong = signal.direction === 'long';
  const isShort = signal.direction === 'short';
  const dirColor = isLong ? 'text-green-400' : isShort ? 'text-red-400' : 'text-slate-400';
  const dirBg = isLong ? 'bg-green-500/10 border-green-500/30'
    : isShort ? 'bg-red-500/10 border-red-500/30'
    : 'bg-dark-800/40 border-dark-600/40';

  return (
    <div className={`rounded-xl border overflow-hidden transition-all ${dirBg} ${highlight ? 'shadow-lg' : ''}`}>
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            isLong ? 'bg-green-400 animate-pulse' : isShort ? 'bg-red-400 animate-pulse' : 'bg-slate-500'
          }`} />
          <span className="text-xs text-white font-medium truncate">{signal.strategyName}</span>
          {signal.triggered && (
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
              isLong ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
            } animate-pulse`}>
              触发
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className={`text-xs font-bold ${dirColor}`}>
            {isLong ? '做多' : isShort ? '做空' : '观望'}
          </span>
          {signal.strength > 0 && (
            <span className="text-[10px] text-dark-400">{signal.strength}</span>
          )}
          <svg className={`w-3 h-3 text-dark-500 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* 触发信号：展示价位 */}
      {signal.triggered && signal.entryPrice && (
        <div className="grid grid-cols-4 gap-px bg-dark-700/20 border-t border-dark-700/30">
          <div className="bg-dark-800/60 p-2 text-center">
            <span className="text-[9px] text-blue-400/80 block">入场</span>
            <span className="text-xs font-bold text-white font-mono">{fp(signal.entryPrice)}</span>
          </div>
          <div className="bg-dark-800/60 p-2 text-center">
            <span className="text-[9px] text-red-400/80 block">止损</span>
            <span className="text-xs font-bold text-red-400 font-mono">{fp(signal.stopLoss)}</span>
          </div>
          <div className="bg-dark-800/60 p-2 text-center">
            <span className="text-[9px] text-green-400/80 block">止盈1</span>
            <span className="text-xs font-bold text-green-400 font-mono">{fp(signal.takeProfit1)}</span>
          </div>
          <div className="bg-dark-800/60 p-2 text-center">
            <span className="text-[9px] text-emerald-400/80 block">止盈2</span>
            <span className="text-xs font-bold text-emerald-400 font-mono">{fp(signal.takeProfit2)}</span>
          </div>
        </div>
      )}

      {/* 建议 */}
      <div className="px-3 py-2 border-t border-dark-700/20">
        <p className="text-[11px] text-slate-300 leading-relaxed">{signal.advice}</p>
        {signal.triggered && signal.riskReward && (
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[9px] text-dark-500">盈亏比</span>
            <span className="text-[10px] text-amber-400 font-bold">1 : {signal.riskReward.toFixed(2)}</span>
          </div>
        )}
      </div>

      {/* 展开条件详情 */}
      {expanded && signal.conditions.length > 0 && (
        <div className="px-3 py-2 border-t border-dark-700/20 bg-dark-900/30">
          <div className="text-[9px] text-dark-500 uppercase tracking-wider mb-1.5">条件详情</div>
          <div className="space-y-1">
            {signal.conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px]">
                <span className={c.passed ? 'text-green-400' : 'text-dark-600'}>
                  {c.passed ? '✓' : '✗'}
                </span>
                <span className={c.passed ? 'text-slate-300' : 'text-dark-500'}>{c.label}</span>
                {c.detail && <span className="text-dark-600 ml-auto font-mono">{c.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
