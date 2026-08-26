'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchKlines } from '@/shared/lib/market-data';
import { calcTrendSignal, TrendSignal } from '@/shared/lib/indicators';
import useSymbolStore from '@/store/symbolStore';

/** 展示的周期集合：短线 → 长线（覆盖日内到日线级别） */
const TREND_INTERVALS = ['5m', '15m', '1h', '4h', '1d'] as const;

/** 每周期拉取的K线数量：EMA60 需要足够历史（60根起步，取120根保证平滑） */
const BAR_COUNT = 120;

/** 刷新间隔（ms）：fetchKlines 自带分级 TTL 缓存，30s 巡检不会打爆行情源 */
const REFRESH_MS = 30_000;

/** 折叠状态持久化 key（前台直接管控，不走后台） */
const COLLAPSE_KEY = 'multi-trend-collapsed';

interface TrendRow {
  interval: string;
  signal: TrendSignal | null;
}

/** 单个趋势格子的配色：按评级映射（与全站绿涨红跌规范一致） */
const TREND_STYLES: Record<string, { text: string; bg: string; dot: string }> = {
  '强多头': { text: 'text-green-400', bg: 'bg-green-500/10 border-green-500/30', dot: 'bg-green-400' },
  '偏多': { text: 'text-green-500/80', bg: 'bg-green-500/5 border-green-500/15', dot: 'bg-green-500/60' },
  '震荡': { text: 'text-dark-300', bg: 'bg-dark-800/30 border-dark-700/40', dot: 'bg-dark-500' },
  '偏空': { text: 'text-red-500/80', bg: 'bg-red-500/5 border-red-500/15', dot: 'bg-red-500/60' },
  '强空头': { text: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30', dot: 'bg-red-400' },
};

/** 汇总：多数周期同向 → 共振/主导；多空接近 → 分歧/震荡 */
function summarize(rows: TrendRow[]): { text: string; className: string } {
  const valid = rows.filter((r) => r.signal);
  if (valid.length === 0) return { text: '暂无数据', className: 'text-dark-400' };
  const bulls = valid.filter((r) => r.signal!.direction === 'bullish').length;
  const bears = valid.filter((r) => r.signal!.direction === 'bearish').length;
  const neutrals = valid.length - bulls - bears;

  if (bulls === valid.length) return { text: `多头共振 ${bulls}/${valid.length}`, className: 'text-green-400' };
  if (bears === valid.length) return { text: `空头共振 ${bears}/${valid.length}`, className: 'text-red-400' };
  if (bulls > bears && bulls >= Math.ceil(valid.length / 2)) {
    return { text: `多头主导 ${bulls}多/${bears}空`, className: 'text-green-400' };
  }
  if (bears > bulls && bears >= Math.ceil(valid.length / 2)) {
    return { text: `空头主导 ${bears}空/${bulls}多`, className: 'text-red-400' };
  }
  return { text: `多空分歧 ${bulls}多/${bears}空/${neutrals}震荡`, className: 'text-amber-400' };
}

function loadCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function MultiTrendCard() {
  const { symbol, okxId, label } = useSymbolStore();
  const [rows, setRows] = useState<TrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>(0);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  const load = useCallback(async () => {
    // 多周期并发拉取（fetchKlines 内部有 TTL 缓存 + 并发去重，重复调用零开销）
    const results = await Promise.allSettled(
      TREND_INTERVALS.map((iv) => fetchKlines(symbol, okxId, iv, BAR_COUNT)),
    );
    setRows(
      results.map((r, i) => ({
        interval: TREND_INTERVALS[i],
        signal: r.status === 'fulfilled' ? calcTrendSignal(r.value) : null,
      })),
    );
    setUpdatedAt(Date.now());
    setLoading(false);
  }, [symbol, okxId]);

  useEffect(() => {
    setLoading(true);
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const summary = summarize(rows);

  return (
    <div className="glass-card p-4">
      {/* 标题栏：点击整行可折叠/展开（前台直接管控，localStorage 持久化） */}
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={toggleCollapsed}
      >
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold text-sm">多周期趋势</span>
          <span className="text-dark-400 text-xs">{label}</span>
          {!loading && rows.length > 0 && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded ${summary.className}`}>
              {summary.text}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <span className="text-dark-500 text-xs">加载中...</span>
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

      {/* 周期格子：折叠时隐藏 */}
      {!collapsed && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-3">
          {TREND_INTERVALS.map((iv) => {
            const row = rows.find((r) => r.interval === iv);
            const signal = row?.signal ?? null;
            const style = signal ? TREND_STYLES[signal.label] ?? TREND_STYLES['震荡'] : TREND_STYLES['震荡'];
            const up = (signal?.changePercent ?? 0) >= 0;
            return (
              <div key={iv} className={`rounded-lg border p-3 ${style.bg}`}>
                <div className="flex items-center justify-between">
                  <span className="text-dark-300 text-xs font-medium">{iv}</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                </div>
                <div className={`text-sm font-semibold mt-1.5 ${style.text}`}>
                  {loading ? '--' : signal ? signal.label : '暂无数据'}
                </div>
                <div className={`text-xs mt-0.5 font-mono ${up ? 'text-green-400' : 'text-red-400'}`}>
                  {signal
                    ? `${up ? '+' : ''}${signal.changePercent.toFixed(2)}%`
                    : '--'}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 图例说明 */}
      {!collapsed && (
        <div className="flex items-center gap-4 mt-2.5 text-dark-500 text-xs">
          <span>评级：价格与 EMA20/EMA60 三重位置打分</span>
          <span className="hidden sm:inline">数据仅供参考，不构成投资建议</span>
        </div>
      )}
    </div>
  );
}
