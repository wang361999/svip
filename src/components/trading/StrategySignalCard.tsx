'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchKlines } from '@/shared/lib/market-data';
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

const LARGE_INTERVAL = '4h';
const MEDIUM_INTERVAL = '1h';
const SMALL_INTERVAL = '15m';

const BAR_COUNT = 180;
const REFRESH_MS = 30_000;
const COLLAPSE_KEY = 'strategy-signal-collapsed';

/** 信号配色方案 */
const SIGNAL_STYLES = {
  long_strong: {
    text: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/30',
    badge: 'bg-green-500/15 text-green-400',
    label: '强多信号',
    icon: '▲',
  },
  long_weak: {
    text: 'text-green-500/70',
    bg: 'bg-green-500/5',
    border: 'border-green-500/15',
    badge: 'bg-green-500/10 text-green-500/70',
    label: '偏多信号',
    icon: '▲',
  },
  short_strong: {
    text: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    badge: 'bg-red-500/15 text-red-400',
    label: '强空信号',
    icon: '▼',
  },
  short_weak: {
    text: 'text-red-500/70',
    bg: 'bg-red-500/5',
    border: 'border-red-500/15',
    badge: 'bg-red-500/10 text-red-500/70',
    label: '偏空信号',
    icon: '▼',
  },
  wait_normal: {
    text: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    badge: 'bg-amber-500/15 text-amber-400',
    label: '关注中',
    icon: '◆',
  },
  wait_weak: {
    text: 'text-dark-300',
    bg: 'bg-dark-800/50',
    border: 'border-dark-700/40',
    badge: 'bg-dark-700/50 text-dark-400',
    label: '观望',
    icon: '◇',
  },
};

function getSignalStyle(action: string, strength: string) {
  const key = `${action}_${strength}` as keyof typeof SIGNAL_STYLES;
  return SIGNAL_STYLES[key] ?? SIGNAL_STYLES.wait_weak;
}

function loadCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function formatPrice(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

export default function StrategySignalCard() {
  const { symbol, okxId, label } = useSymbolStore();
  const [signal, setSignal] = useState<StrategySignal | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const loadSignal = useCallback(async () => {
    if (!symbol || !okxId) return;

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
    setUpdatedAt(Date.now());
    setLoading(false);
  }, [symbol, okxId]);

  useEffect(() => {
    setLoading(true);
    loadSignal();
    const timer = setInterval(loadSignal, REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadSignal]);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const style = signal ? getSignalStyle(signal.action, signal.strength) : SIGNAL_STYLES.wait_weak;

  return (
    <div className="glass-card p-4">
      {/* 标题栏 */}
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={toggleCollapse}
      >
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold text-sm">策略信号</span>
          <span className="text-dark-400 text-xs">{label}</span>
          {signal && !loading && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.badge}`}>
              {style.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <span className="text-dark-500 text-xs">分析中...</span>
          ) : (
            updatedAt > 0 && (
              <span className="text-dark-500 text-xs">
                {new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
            )
          )}
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
          {/* 主信号区：方向 + 状态描述 + 共振等级 */}
          <div className={`rounded-lg border p-4 ${style.bg} ${style.border}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`text-2xl font-bold ${style.text}`}>
                    {style.icon}
                  </span>
                  <span className={`text-lg font-bold ${style.text}`}>
                    {loading ? '分析中' : signal ? getActionText(signal.action) : '暂无数据'}
                  </span>
                </div>
                <p className="text-dark-300 text-sm mt-1.5 leading-relaxed">
                  {loading ? '正在计算三周期共振信号...' : signal?.status ?? '暂无数据'}
                </p>
              </div>
              {/* 共振等级 */}
              {signal && !loading && (
                <div className="text-right">
                  <div className="text-dark-400 text-xs mb-1">共振等级</div>
                  <div className="flex gap-1 justify-end">
                    {[1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`w-2.5 h-5 rounded-sm transition-all ${
                          i <= signal.resonanceLevel
                            ? signal.action === 'long'
                              ? 'bg-green-400'
                              : signal.action === 'short'
                              ? 'bg-red-400'
                              : 'bg-amber-400'
                            : 'bg-dark-700'
                        }`}
                      />
                    ))}
                  </div>
                  <div className="text-dark-500 text-xs mt-1">
                    {signal.resonanceLevel}/3 周期
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 交易点位 */}
          {signal && (signal.entryPrice || signal.stopLoss || signal.target1) && (
            <div className="grid grid-cols-4 gap-2">
              <PriceBox label="入场" value={signal.entryPrice} tone="default" />
              <PriceBox label="止损" value={signal.stopLoss} tone="red" />
              <PriceBox label="目标1" value={signal.target1} tone="green" />
              <PriceBox label="目标2" value={signal.target2} tone="green" />
            </div>
          )}

          {/* 盈亏比 */}
          {signal && signal.riskReward !== null && (
            <div className="flex items-center justify-between px-4 py-3 bg-dark-800/40 rounded-lg border border-dark-700/40">
              <div className="flex items-center gap-2">
                <span className="text-dark-400 text-sm">盈亏比</span>
                <span className="text-dark-600 text-xs">R:R</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span
                  className={`text-2xl font-bold font-mono ${
                    signal.riskReward >= 3
                      ? 'text-green-400'
                      : signal.riskReward >= 2
                      ? 'text-green-500/80'
                      : 'text-amber-400'
                  }`}
                >
                  {signal.riskReward}
                </span>
                <span className="text-dark-500 text-sm">: 1</span>
                {signal.riskReward >= 2 && signal.action !== 'wait' && (
                  <span className="text-green-400/70 text-xs ml-1">✓ 达标</span>
                )}
                {signal.riskReward < 2 && signal.action !== 'wait' && (
                  <span className="text-amber-400/70 text-xs ml-1">⚠ 偏低</span>
                )}
              </div>
            </div>
          )}

          {/* 三周期拆解 */}
          {signal && (
            <div className="space-y-2">
              <div className="text-dark-400 text-xs font-medium">周期拆解</div>
              <div className="space-y-1.5">
                <CycleRow
                  label="大周期"
                  interval={LARGE_INTERVAL}
                  value={signal.breakdown.large.label}
                  direction={signal.breakdown.large.direction}
                />
                <CycleRow
                  label="中周期"
                  interval={MEDIUM_INTERVAL}
                  value={`${signal.breakdown.medium.label} · ${signal.breakdown.medium.position}`}
                  direction={signal.breakdown.medium.direction}
                />
                <CycleRow
                  label="小周期"
                  interval={SMALL_INTERVAL}
                  value={signal.breakdown.small.label}
                  direction={signal.breakdown.small.direction}
                />
              </div>
            </div>
          )}

          {/* 底部说明 */}
          <div className="pt-2 border-t border-dark-700/40 flex items-center justify-between text-xs text-dark-500">
            <span>4h 定方向 / 1h 找结构 / 15m 确认</span>
            <span className="hidden sm:inline">仅供参考 · 严格止损</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────── 子组件 ────────── */

function PriceBox({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number | null;
  tone?: 'default' | 'green' | 'red';
}) {
  const toneClass =
    tone === 'green'
      ? 'text-green-400'
      : tone === 'red'
      ? 'text-red-400'
      : 'text-dark-200';

  return (
    <div className="bg-dark-800/40 rounded-lg p-2.5 text-center border border-dark-700/40">
      <div className="text-dark-500 text-xs mb-1">{label}</div>
      <div className={`font-mono font-semibold text-sm ${value !== null ? toneClass : 'text-dark-600'}`}>
        {formatPrice(value)}
      </div>
    </div>
  );
}

function CycleRow({
  label,
  interval,
  value,
  direction,
}: {
  label: string;
  interval: string;
  value: string;
  direction: string;
}) {
  const dotColor =
    direction === 'bullish'
      ? 'bg-green-400'
      : direction === 'bearish'
      ? 'bg-red-400'
      : 'bg-dark-500';

  const textColor =
    direction === 'bullish'
      ? 'text-green-400'
      : direction === 'bearish'
      ? 'text-red-400'
      : 'text-dark-300';

  return (
    <div className="flex items-center justify-between px-3 py-2 bg-dark-800/30 rounded-lg">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-dark-400 text-xs">
          {label} <span className="text-dark-600">({interval})</span>
        </span>
      </div>
      <span className={`text-xs font-medium ${textColor}`}>{value}</span>
    </div>
  );
}

/* ────────── 工具函数 ────────── */

function getActionText(action: string): string {
  switch (action) {
    case 'long':
      return '建议做多';
    case 'short':
      return '建议做空';
    default:
      return '观望等待';
  }
}
