'use client';

import { useEffect, useState, useCallback } from 'react';
import { fetchKlines } from '@/shared/lib/market-data';
import { analyzeTimeframe, TimeframeResult, Direction } from '@/shared/lib/trend-analysis';
import useSymbolStore from '@/store/symbolStore';

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const INDICATORS: { key: keyof TimeframeResult['signals']; label: string }[] = [
  { key: 'ema', label: 'EMA' },
  { key: 'boll', label: 'BOLL' },
  { key: 'macd', label: 'MACD' },
  { key: 'rsi', label: 'RSI' },
  { key: 'atr', label: 'ATR' },
];

function dirColor(d: Direction) {
  if (d === '多') return 'text-green-400';
  if (d === '空') return 'text-red-400';
  return 'text-dark-500';
}

function dirBg(d: Direction) {
  if (d === '多') return 'bg-green-500/15 border-green-500/30';
  if (d === '空') return 'bg-red-500/15 border-red-500/30';
  return 'bg-dark-800/50 border-dark-700';
}

export default function TrendPanel() {
  const symbol = useSymbolStore((s) => s.symbol);
  const okxId = useSymbolStore((s) => s.okxId);
  const symbolLabel = useSymbolStore((s) => s.label);
  const [results, setResults] = useState<Record<string, TimeframeResult | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await Promise.all(
        TIMEFRAMES.map(async (tf) => {
          try {
            const klines = await fetchKlines(symbol, okxId, tf, 200);
            return [tf, analyzeTimeframe(klines, tf)] as const;
          } catch {
            return [tf, null] as const;
          }
        })
      );
      const map: Record<string, TimeframeResult | null> = {};
      for (const [tf, res] of entries) map[tf] = res;
      setResults(map);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [symbol, okxId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && Object.keys(results).length === 0) {
    return (
      <div className="rounded-xl border border-dark-700 bg-dark-900/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-white">多周期多空</span>
          <span className="text-xs text-dark-500">加载中...</span>
        </div>
        <div className="flex items-center justify-center h-20">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-dark-700 bg-dark-900/50 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-white">多周期多空</span>
        </div>
        <div className="text-center text-red-400 text-sm py-6">{error}</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dark-700 bg-dark-900/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-white">
          多周期多空 <span className="text-dark-500 ml-1">{symbolLabel}</span>
        </span>
        <button
          onClick={load}
          className="text-xs text-dark-400 hover:text-blue-400 transition"
          disabled={loading}
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-dark-700">
              <th className="text-left py-2 px-2 text-dark-400 font-normal text-xs">指标</th>
              {TIMEFRAMES.map((tf) => {
                const r = results[tf];
                return (
                  <th key={tf} className="text-center py-2 px-2 font-normal">
                    <div className="flex flex-col items-center">
                      <span className="text-dark-300 text-xs">{r?.timeframe || tf}</span>
                      {r && (
                        <span className="text-dark-500 text-[10px] mt-0.5">
                          ${r.lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {INDICATORS.map((ind) => (
              <tr key={ind.key} className="border-b border-dark-800/50">
                <td className="py-2 px-2 text-dark-300 text-xs font-medium">{ind.label}</td>
                {TIMEFRAMES.map((tf) => {
                  const r = results[tf];
                  const d = r?.signals[ind.key] || '震荡';
                  return (
                    <td key={tf} className="text-center py-2 px-2">
                      <span className={`inline-block w-8 py-0.5 rounded border text-xs font-medium ${dirBg(d)} ${dirColor(d)}`}>
                        {d}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="py-2.5 px-2 text-white text-xs font-bold">综合</td>
              {TIMEFRAMES.map((tf) => {
                const r = results[tf];
                const d = r?.overall || '震荡';
                const score = r?.score || 0;
                return (
                  <td key={tf} className="text-center py-2.5 px-2">
                    <span className={`inline-block px-3 py-1 rounded-full border text-sm font-bold ${dirBg(d)} ${dirColor(d)}`}>
                      {d}
                      <span className="ml-1 text-[10px] opacity-60">{score > 0 ? `+${score}` : score}</span>
                    </span>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-2 text-right text-dark-500 text-[10px]">
        每30秒刷新 · 数据仅供参考
      </div>
    </div>
  );
}
