'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchKlines, INTERVALS, KlineData } from '@/shared/lib/market-data';
import {
  calcTrendSignal,
  calcStrategySignal,
  StrategySignal,
  TrendSignal,
} from '@/shared/lib/indicators';
import useSymbolStore from '@/store/symbolStore';

/**
 * 策略信号卡片
 *
 * 基于"Alpha 结构交易法"：三周期共振 + 结构位 + 盈亏比过滤
 *   大周期（4h）定方向
 *   中周期（1h）找结构位（AB9 / 斐波那契）
 *   小周期（15m）确认入场
 */

const LARGE_INTERVAL = '4h';   // 大周期：定方向
const MEDIUM_INTERVAL = '1h';  // 中周期：找结构位
const SMALL_INTERVAL = '15m';  // 小周期：入场确认

const BAR_COUNT = 180;         // 每周期拉取 K 线数（足够覆盖多个波段）
const REFRESH_MS = 30_000;     // 刷新间隔：30 秒巡检
const COLLAPSE_KEY = 'strategy-signal-collapsed';

export default function StrategySignalCard({ hidden }: { hidden?: boolean }) {
  const { symbol, okxId } = useSymbolStore();
  const [signal, setSignal] = useState<StrategySignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  // 折叠状态持久化
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem(COLLAPSE_KEY) : null;
    if (saved !== null) setCollapsed(saved === '1');
  }, []);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    }
  };

  const loadSignal = useCallback(async () => {
    if (!symbol || !okxId) return;

    // 并行拉取三个周期的 K 线
    const [largeRes, mediumRes, smallRes] = await Promise.allSettled([
      fetchKlines(symbol, okxId, LARGE_INTERVAL, BAR_COUNT),
      fetchKlines(symbol, okxId, MEDIUM_INTERVAL, BAR_COUNT),
      fetchKlines(symbol, okxId, SMALL_INTERVAL, BAR_COUNT),
    ]);

    const largeKlines = largeRes.status === 'fulfilled' ? largeRes.value : [];
    const mediumKlines = mediumRes.status === 'fulfilled' ? mediumRes.value : [];
    const smallKlines = smallRes.status === 'fulfilled' ? smallRes.value : [];

    const largeTrend = calcTrendSignal(largeKlines);
    const smallTrend = calcTrendSignal(smallKlines);

    const sig = calcStrategySignal(largeTrend, mediumKlines, smallTrend);
    setSignal(sig);
    setLoading(false);
  }, [symbol, okxId]);

  // 初始加载 + 周期/币种切换时刷新
  useEffect(() => {
    setLoading(true);
    loadSignal();
  }, [loadSignal]);

  // 定时刷新
  useEffect(() => {
    const timer = setInterval(loadSignal, REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadSignal]);

  if (hidden) return null;

  const actionInfo = getActionInfo(signal?.action ?? 'wait', signal?.strength ?? 'weak');

  return (
    <div className="glass-card rounded-xl p-4 mb-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-3 cursor-pointer select-none" onClick={toggleCollapse}>
        <div className="flex items-center gap-2">
          <span className="text-base font-bold">🎯 策略信号</span>
          {signal && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${actionInfo.badge}`}>
              {actionInfo.label}
            </span>
          )}
        </div>
        <span className="text-dark-400 text-sm transition-transform" style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}>
          ▾
        </span>
      </div>

      {!collapsed && (
        <>
          {/* 状态描述 */}
          <div className={`p-3 rounded-lg mb-3 ${actionInfo.bg}`}>
            <div className={`font-bold text-sm ${actionInfo.text}`}>
              {loading ? '分析中…' : signal?.status ?? '暂无数据'}
            </div>
            {signal && signal.resonanceLevel > 0 && (
              <div className="text-xs text-dark-400 mt-1">
                共振等级：{'●'.repeat(signal.resonanceLevel)}{'○'.repeat(3 - signal.resonanceLevel)}
                <span className="ml-1">（{signal.resonanceLevel}/3 周期同向）</span>
              </div>
            )}
          </div>

          {/* 交易点位 */}
          {signal && (signal.entryPrice || signal.stopLoss || signal.target1) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <PriceBox label="入场价" value={signal.entryPrice} />
              <PriceBox label="止损" value={signal.stopLoss} tone="red" />
              <PriceBox label="目标1" value={signal.target1} tone="green" />
              <PriceBox label="目标2" value={signal.target2} tone="green" />
            </div>
          )}

          {/* 盈亏比 */}
          {signal && signal.riskReward !== null && (
            <div className="flex items-center justify-between px-3 py-2 bg-dark-800/30 rounded-lg mb-3">
              <span className="text-sm text-dark-400">盈亏比</span>
              <span className={`font-bold font-mono ${
                signal.riskReward >= 3 ? 'text-green-400' :
                signal.riskReward >= 2 ? 'text-green-500/80' :
                'text-amber-400'
              }`}>
                {signal.riskReward}:1
              </span>
            </div>
          )}

          {/* 三周期拆解 */}
          {signal && (
            <div className="space-y-1.5 text-xs">
              <BreakdownRow label="大周期 (4h)" value={signal.breakdown.large.label} />
              <BreakdownRow
                label="中周期 (1h)"
                value={`${signal.breakdown.medium.label} · ${signal.breakdown.medium.position}`}
              />
              <BreakdownRow label="小周期 (15m)" value={signal.breakdown.small.label} />
            </div>
          )}

          {/* 提示 */}
          <div className="mt-3 pt-3 border-t border-dark-700/40 text-xs text-dark-500 leading-relaxed">
            ⚠️ 仅供参考，不构成投资建议。严格执行止损，单笔亏损不超过总资金 2%。
          </div>
        </>
      )}
    </div>
  );
}

/* ────────── 子组件 ────────── */

function PriceBox({ label, value, tone = 'default' }: { label: string; value: number | null; tone?: 'default' | 'green' | 'red' }) {
  const toneClass =
    tone === 'green' ? 'text-green-400' :
    tone === 'red' ? 'text-red-400' :
    'text-dark-200';

  return (
    <div className="bg-dark-800/30 rounded-lg p-2 text-center">
      <div className="text-xs text-dark-500 mb-0.5">{label}</div>
      <div className={`font-mono font-bold text-sm ${value !== null ? toneClass : 'text-dark-600'}`}>
        {value !== null ? formatPrice(value) : '—'}
      </div>
    </div>
  );
}

function BreakdownRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-dark-500">{label}</span>
      <span className="text-dark-300 font-medium">{value}</span>
    </div>
  );
}

/* ────────── 工具函数 ────────── */

function getActionInfo(action: string, strength: string) {
  if (action === 'long') {
    if (strength === 'strong') {
      return { label: '强多信号', text: 'text-green-400', bg: 'bg-green-500/10', badge: 'bg-green-500/20 text-green-400' };
    }
    return { label: '偏多信号', text: 'text-green-500/80', bg: 'bg-green-500/5', badge: 'bg-green-500/15 text-green-500/80' };
  }
  if (action === 'short') {
    if (strength === 'strong') {
      return { label: '强空信号', text: 'text-red-400', bg: 'bg-red-500/10', badge: 'bg-red-500/20 text-red-400' };
    }
    return { label: '偏空信号', text: 'text-red-500/80', bg: 'bg-red-500/5', badge: 'bg-red-500/15 text-red-500/80' };
  }
  if (strength === 'normal') {
    return { label: '关注中', text: 'text-amber-400', bg: 'bg-amber-500/10', badge: 'bg-amber-500/20 text-amber-400' };
  }
  return { label: '观望', text: 'text-dark-400', bg: 'bg-dark-800/30', badge: 'bg-dark-700/50 text-dark-400' };
}

function formatPrice(v: number): string {
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}
