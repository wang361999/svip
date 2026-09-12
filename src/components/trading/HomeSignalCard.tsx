'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { fetchKlines, KlineData } from '@/shared/lib/market-data';
import SignalPanel from './SignalPanel';

const SYMBOLS = [
  { value: 'ETHUSDT', okxId: 'ETH-USDT', label: 'ETH/USDT' },
  { value: 'BTCUSDT', okxId: 'BTC-USDT', label: 'BTC/USDT' },
] as const;

/**
 * 首页实时决策卡：直接复用交易工作台的 SignalPanel（同一套回测信号逻辑），
 * 4h 周期、300 根、每 30 秒静默刷新。只展示已收盘 K 线，与手动交易流程一致。
 */
export default function HomeSignalCard() {
  const [symbol, setSymbol] = useState<(typeof SYMBOLS)[number]>(SYMBOLS[0]);
  const [klines, setKlines] = useState<KlineData[] | null>(null);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (s: (typeof SYMBOLS)[number]) => {
    try {
      const data = await fetchKlines(s.value, s.okxId, '4h', 300);
      // 剔除未收盘的当前根，信号口径与工作台一致
      setKlines(data.slice(0, -1));
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    setKlines(null);
    load(symbol);
  }, [symbol, load]);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      load(symbol);
      setTick((t) => t + 1);
    }, 30_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [symbol, load]);

  return (
    <div className="relative">
      <div className="absolute -inset-4 bg-emerald-500/10 rounded-[2rem] blur-2xl pointer-events-none" />
      <div className="relative glass-card p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div>
            <div className="text-xs text-dark-500">实时决策卡 · 4小时周期</div>
            <div className="text-lg font-bold text-white">当前该怎么做</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-dark-700/70 overflow-hidden">
              {SYMBOLS.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setSymbol(s)}
                  className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                    symbol.value === s.value
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'text-dark-400 hover:text-slate-200 hover:bg-dark-800/60'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-500/10 text-green-400 text-[11px] border border-green-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              实时
            </span>
          </div>
        </div>

        {klines && klines.length > 50 ? (
          <SignalPanel klines={klines} refreshKey={tick} precision={2} symbol={symbol.value} />
        ) : error ? (
          <div className="rounded-xl border border-dark-700/60 bg-dark-900/50 px-4 py-10 text-center text-sm text-dark-400">
            行情源暂时不可用，请稍后刷新
          </div>
        ) : (
          <div className="rounded-xl border border-dark-700/60 bg-dark-900/50 px-4 py-10 text-center text-sm text-dark-500">
            正在加载 K 线与信号…
          </div>
        )}

        <Link
          href="/trading"
          className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-300 hover:bg-emerald-500/20 transition-colors"
        >
          打开完整工作台（K线图 / 多周期 / 日线信号）
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </Link>
      </div>
    </div>
  );
}
