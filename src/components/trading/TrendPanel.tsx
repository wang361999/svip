'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { fetchKlines } from '@/shared/lib/market-data';
import { analyzeTimeframe, parseFundingRate, TimeframeResult, Direction, FundingRate } from '@/shared/lib/trend-analysis';
import { apiGet } from '@/shared/api/client';
import useSymbolStore from '@/store/symbolStore';

const TIMEFRAMES = ['15m', '1h', '4h', '1d'];
const TF_WEIGHTS: Record<string, number> = { '15m': 0.5, '1h': 1.5, '4h': 2, '1d': 3 };
const INDICATORS: { key: keyof TimeframeResult['signals']; label: string }[] = [
  { key: 'ema', label: 'EMA' },
  { key: 'boll', label: 'BOLL' },
  { key: 'macd', label: 'MACD' },
  { key: 'rsi', label: 'RSI' },
  { key: 'atr', label: 'ATR' },
  { key: 'vol', label: 'VOL' },
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

interface Suggestion {
  action: string;
  advice: string;
  strength: string;
  weightedScore: number;
  color: string;
  bg: string;
}

function calcSuggestion(
  results: Record<string, TimeframeResult | null>,
  funding: FundingRate | null
): Suggestion | null {
  const valid = TIMEFRAMES.filter((tf) => results[tf]);
  if (valid.length === 0) return null;

  let weighted = 0;
  for (const tf of valid) {
    const r = results[tf];
    if (!r) continue;
    const w = TF_WEIGHTS[tf] || 1;
    if (r.overall === '多') weighted += w;
    else if (r.overall === '空') weighted -= w;
  }

  // 资金费率反向修正（权重0.5，因为是反向指标）
  let fundingAdj = 0;
  if (funding) {
    if (funding.direction === '多') fundingAdj = 0.5;
    else if (funding.direction === '空') fundingAdj = -0.5;
  }
  const score = weighted + fundingAdj;

  const d1 = results['1d']?.overall;
  const d4 = results['4h']?.overall;
  const h1 = results['1h']?.overall;
  const m15 = results['15m']?.overall;
  const bigBull = d1 === '多' && d4 === '多';
  const bigBear = d1 === '空' && d4 === '空';
  const allBull = bigBull && h1 === '多' && m15 === '多';
  const allBear = bigBear && h1 === '空' && m15 === '空';

  if (score >= 5 || allBull) {
    return {
      action: '强烈做多',
      advice: '多周期共振看多，逢低买入或加仓，止损设4小时级别低点下方',
      strength: allBull ? '极强（4周期共振）' : '强',
      weightedScore: score,
      color: 'border-green-500/50 text-green-400',
      bg: 'bg-green-500/10',
    };
  }
  if (score >= 2.5 || bigBull) {
    return {
      action: '偏多',
      advice: '大周期偏多，等待15分钟回调企稳后买入，不宜追高',
      strength: '中强',
      weightedScore: score,
      color: 'border-green-500/30 text-green-400',
      bg: 'bg-green-500/5',
    };
  }
  if (score <= -5 || allBear) {
    return {
      action: '强烈做空',
      advice: '多周期共振看空，逢高做空或减仓，反弹4小时高点附近加空',
      strength: allBear ? '极强（4周期共振）' : '强',
      weightedScore: score,
      color: 'border-red-500/50 text-red-400',
      bg: 'bg-red-500/10',
    };
  }
  if (score <= -2.5 || bigBear) {
    return {
      action: '偏空',
      advice: '大周期偏空，等待15分钟反弹乏力后做空，下方支撑可轻仓试多',
      strength: '中强',
      weightedScore: score,
      color: 'border-red-500/30 text-red-400',
      bg: 'bg-red-500/5',
    };
  }

  let advice = '多空分歧较大，方向不明，建议观望等待信号一致';
  if (d1 && d4 && d1 !== d4) {
    advice = '日线和4小时方向不一致，等待大周期方向明确后再操作';
  } else if (bigBull && (h1 === '空' || m15 === '空')) {
    advice = '大周期偏多但小周期走弱，等待小周期回调结束企稳后买入';
  } else if (bigBear && (h1 === '多' || m15 === '多')) {
    advice = '大周期偏空但小周期反弹，等待反弹乏力后顺势做空';
  }
  return {
    action: '观望',
    advice,
    strength: '弱',
    weightedScore: score,
    color: 'border-dark-600 text-dark-300',
    bg: 'bg-dark-800/30',
  };
}

export default function TrendPanel() {
  const symbol = useSymbolStore((s) => s.symbol);
  const okxId = useSymbolStore((s) => s.okxId);
  const symbolLabel = useSymbolStore((s) => s.label);
  const [results, setResults] = useState<Record<string, TimeframeResult | null>>({});
  const [funding, setFunding] = useState<FundingRate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [klineEntries, fundingData] = await Promise.all([
        Promise.all(
          TIMEFRAMES.map(async (tf) => {
            try {
              const klines = await fetchKlines(symbol, okxId, tf, 200);
              return [tf, analyzeTimeframe(klines, tf)] as const;
            } catch {
              return [tf, null] as const;
            }
          })
        ),
        apiGet<{ fundingRate: number }>(`/api/funding-rate?symbol=${symbol}`).catch(() => null),
      ]);

      const map: Record<string, TimeframeResult | null> = {};
      for (const [tf, res] of klineEntries) map[tf] = res;
      setResults(map);

      if (fundingData) {
        setFunding(parseFundingRate(fundingData.fundingRate));
      } else {
        setFunding(null);
      }
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

  const suggestion = useMemo(() => calcSuggestion(results, funding), [results, funding]);

  // 取4小时的关键价位作为参考
  const keyLevels = results['4h'];

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
    <div className="space-y-3">
      {/* 操作建议卡片 */}
      {suggestion && (
        <div className={`rounded-xl border p-4 ${suggestion.color} ${suggestion.bg}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-dark-400">操作建议</span>
                <span className="text-xs text-dark-500">{symbolLabel}</span>
                {funding && (
                  <span className={`text-xs px-2 py-0.5 rounded ${dirColor(funding.direction)}`}>
                    {funding.text}
                  </span>
                )}
              </div>
              <div className={`text-2xl font-bold ${suggestion.color.split(' ')[1]}`}>
                {suggestion.action}
              </div>
              <p className="text-sm text-dark-300 mt-1.5 leading-relaxed">
                {suggestion.advice}
              </p>
              {/* 关键价位 */}
              {keyLevels && (keyLevels.support || keyLevels.resistance) && (
                <div className="flex items-center gap-4 mt-2 text-xs">
                  {keyLevels.resistance != null && (
                    <span className="text-red-400/80">
                      阻力 ${keyLevels.resistance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  )}
                  {keyLevels.support != null && (
                    <span className="text-green-400/80">
                      支撑 ${keyLevels.support.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-col items-end shrink-0">
              <span className="text-xs text-dark-500">信号强度</span>
              <span className={`text-sm font-medium ${suggestion.color.split(' ')[1]}`}>
                {suggestion.strength}
              </span>
              <span className="text-xs text-dark-500 mt-1">加权分</span>
              <span className={`text-lg font-bold ${suggestion.color.split(' ')[1]}`}>
                {suggestion.weightedScore > 0 ? '+' : ''}{suggestion.weightedScore.toFixed(1)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 多空表格 */}
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
              {/* 关键价位行 */}
              <tr className="border-t border-dark-700">
                <td className="py-2 px-2 text-dark-400 text-[10px]">支撑</td>
                {TIMEFRAMES.map((tf) => {
                  const r = results[tf];
                  return (
                    <td key={tf} className="text-center py-2 px-2 text-green-400/70 text-[10px]">
                      {r?.support != null ? `$${r.support.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                    </td>
                  );
                })}
              </tr>
              <tr>
                <td className="py-1 px-2 text-dark-400 text-[10px]">阻力</td>
                {TIMEFRAMES.map((tf) => {
                  const r = results[tf];
                  return (
                    <td key={tf} className="text-center py-1 px-2 text-red-400/70 text-[10px]">
                      {r?.resistance != null ? `$${r.resistance.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-2 text-right text-dark-500 text-[10px]">
          每30秒刷新 · 数据仅供参考，不构成投资建议
        </div>
      </div>
    </div>
  );
}
