'use client';

import { useEffect, useState, useCallback } from 'react';
import useSymbolStore from '@/store/symbolStore';
import { apiGet } from '@/shared/api/client';

interface TrendTimeframe {
  tf: string;
  label: string;
  trend: 'long' | 'short' | 'neutral';
  score: number; // -100 ~ 100
  adx: number;
  close: number;
  changePct: number;
  reasons: string[];
}

interface TrendData {
  symbol: string;
  currentPrice: number;
  timeframes: TrendTimeframe[];
  overall: {
    longCount: number;
    shortCount: number;
    neutralCount: number;
    trend: 'long' | 'short' | 'neutral';
    summary: string;
  };
}

const trendConfig = {
  long: { label: '多头', color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/30', icon: '▲', bar: 'bg-green-500' },
  short: { label: '空头', color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30', icon: '▼', bar: 'bg-red-500' },
  neutral: { label: '震荡', color: 'text-dark-300', bg: 'bg-dark-700/30', border: 'border-dark-600/30', icon: '●', bar: 'bg-dark-500' },
};

export default function TrendPanel() {
  const { symbol, okxId, label } = useSymbolStore();
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchData = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const result = await apiGet<TrendData>(
        `/api/market/trend?symbol=${symbol}&okxId=${encodeURIComponent(okxId)}`,
      );
      setData(result);
      setError('');
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取趋势失败');
    } finally {
      setLoading(false);
    }
  }, [symbol, okxId]);

  // 初始加载 + 切换币种时刷新
  useEffect(() => {
    setData(null);
    fetchData(true);
  }, [fetchData]);

  // 每 60 秒自动刷新（缓存 30 秒，行情源压力可控）
  useEffect(() => {
    const timer = setInterval(() => fetchData(false), 60_000);
    return () => clearInterval(timer);
  }, [fetchData]);

  const formatPrice = (p: number) =>
    p > 0 ? p.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '-';

  const formatTime = (d: Date | null) =>
    d ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  const overall = data ? trendConfig[data.overall.trend] : null;

  return (
    <div className="glass-card p-5">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M3 21h18M5 21V7a2 2 0 012-2h10a2 2 0 012 2v14" />
          </svg>
          <h2 className="text-lg font-semibold text-white">多周期趋势</h2>
          <span className="text-xs text-dark-500">{label}</span>
          {data && overall && (
            <span className={`px-2 py-0.5 rounded text-xs font-medium border ${overall.bg} ${overall.color} ${overall.border}`}>
              {overall.icon} {overall.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {updatedAt && <span className="text-dark-500 text-xs">{formatTime(updatedAt)} 更新</span>}
          <button
            onClick={() => fetchData(true)}
            disabled={loading}
            className="px-3 py-2 rounded-lg bg-dark-800 hover:bg-dark-700 text-dark-300 text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {loading ? (
              <div className="w-3.5 h-3.5 border-2 border-dark-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0114-3M20 15a8 8 0 01-14 3" />
              </svg>
            )}
            刷新
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
      {loading && !data && (
        <div className="flex items-center justify-center py-10">
          <div className="w-8 h-8 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {data && (
        <>
          {/* 四周期卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {data.timeframes.map((tf) => {
              const cfg = trendConfig[tf.trend];
              // 得分条：-100~100 映射到 0~100%（50 为中点）
              const barPos = ((tf.score + 100) / 200) * 100;
              return (
                <div key={tf.tf} className={`p-3 rounded-lg ${cfg.bg} border ${cfg.border}`}>
                  {/* 周期 + 方向 */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-dark-300 text-xs font-medium">{tf.label}</span>
                    <span className={`text-sm font-bold ${cfg.color}`}>{cfg.icon} {cfg.label}</span>
                  </div>

                  {/* 涨跌幅 */}
                  <div className="flex items-center justify-between text-xs mb-2">
                    <span className="text-dark-500">近期涨跌</span>
                    <span className={tf.changePct > 0 ? 'text-green-400' : tf.changePct < 0 ? 'text-red-400' : 'text-dark-400'}>
                      {tf.changePct > 0 ? '+' : ''}{tf.changePct}%
                    </span>
                  </div>

                  {/* 得分条 */}
                  <div className="relative w-full h-1.5 bg-dark-800 rounded-full overflow-hidden mb-1">
                    {/* 中点刻度 */}
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-dark-600" />
                    <div
                      className={`absolute top-0 bottom-0 w-1.5 rounded-full ${cfg.bar} transition-all`}
                      style={{ left: `calc(${Math.min(Math.max(barPos, 1), 99)}% - 3px)` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-dark-500 mb-2">
                    <span>空</span>
                    <span>强度 {cfg.label === '震荡' ? '-' : Math.abs(tf.score)} · ADX {tf.adx}</span>
                    <span>多</span>
                  </div>

                  {/* 收盘价 */}
                  <div className="text-dark-400 text-[11px] truncate">收盘 {formatPrice(tf.close)}</div>
                </div>
              );
            })}
          </div>

          {/* 综合结论 + 因子明细切换 */}
          <div className="mt-4 flex items-center justify-between">
            <div className="text-sm">
              <span className="text-dark-400">综合：</span>
              <span className={`font-medium ${overall?.color}`}>{data.overall.summary}</span>
              <span className="text-dark-500 text-xs ml-2">
                （多 {data.overall.longCount} / 空 {data.overall.shortCount} / 震荡 {data.overall.neutralCount}）
              </span>
            </div>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1 text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              <svg className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {expanded ? '收起判定依据' : '查看判定依据'}
            </button>
          </div>

          {/* 因子明细（展开） */}
          {expanded && (
            <div className="mt-2 p-3 rounded-lg bg-dark-900/60 border border-dark-800">
              <div className="grid md:grid-cols-2 gap-3">
                {data.timeframes.map((tf) => {
                  const cfg = trendConfig[tf.trend];
                  return (
                    <div key={tf.tf}>
                      <div className={`text-xs font-medium mb-1 ${cfg.color}`}>
                        {tf.label} — {cfg.icon} {cfg.label}（得分 {tf.score > 0 ? '+' : ''}{tf.score}）
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {tf.reasons.map((r, i) => (
                          <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-dark-800/60 border border-dark-700/30 text-dark-300">
                            {r}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-dark-500 text-[11px] mt-3">
                判定规则：EMA20/SMA50/SMA200 均线位置 + MACD 动能 + EMA20 斜率五因子打分，|得分|≥2 且 ADX≥18 才判定多空，否则视为震荡
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
