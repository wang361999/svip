'use client';

/**
 * 快速信号卡片 v2 · RapidSignalCard
 *
 * v2：评分制 (0-100) + 趋势过滤 + 成交量 + 背离 + 冷却期
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { apiGet } from '@/shared/api/client';
import useChartStore from '@/store/chartStore';

// ==================== 声音提醒工具 ====================

let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  return audioCtx;
}

/** 播放做多信号音：两声升调（低→高） */
function playLongSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;
  // 第一声：523Hz (C5)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(523, now);
  gain1.gain.setValueAtTime(0, now);
  gain1.gain.linearRampToValueAtTime(0.3, now + 0.02);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.25);

  // 第二声：784Hz (G5)，延迟0.15s
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(784, now + 0.15);
  gain2.gain.setValueAtTime(0, now + 0.15);
  gain2.gain.linearRampToValueAtTime(0.3, now + 0.17);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.4);
}

/** 播放做空信号音：两声降调（高→低） */
function playShortSound() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();

  const now = ctx.currentTime;
  // 第一声：784Hz (G5)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(784, now);
  gain1.gain.setValueAtTime(0, now);
  gain1.gain.linearRampToValueAtTime(0.3, now + 0.02);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.25);

  // 第二声：523Hz (C5)，延迟0.15s
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(523, now + 0.15);
  gain2.gain.setValueAtTime(0, now + 0.15);
  gain2.gain.linearRampToValueAtTime(0.3, now + 0.17);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.4);
}

/** 测试声音 */
function playTestSound() {
  playLongSound();
  setTimeout(() => playShortSound(), 600);
}

interface ScoreBreakdown {
  trend: number;
  momentum: number;
  bollinger: number;
  divergence: number;
  volume: number;
  total: number;
  direction: 'long' | 'short' | 'none';
}

interface RapidSignal {
  id: string;
  source: string;
  direction: 'long' | 'short';
  entry: number;
  stop: number;
  target: number;
  atr: number;
  confidence: number;
  confluenceSources: string[];
  time: number;
  reason: string;
  barIndex: number;
}

interface IndicatorState {
  ema9: number;
  ema21: number;
  ema50: number;
  emaCross: 'up' | 'down' | 'none';
  trend: 'up' | 'down' | 'neutral';
  bollingerUpper: number;
  bollingerMiddle: number;
  bollingerLower: number;
  bollingerPosition: 'above-upper' | 'below-lower' | 'middle';
  rsi: number;
  rsiState: 'oversold' | 'overbought' | 'neutral';
  macdHist: number;
  macdHistTrend: 'rising' | 'falling' | 'flat';
  atr: number;
  price: number;
  volumeAvg: number;
  currentVolume: number;
  rsiDivergence: 'bull' | 'bear' | 'none';
  macdDivergence: 'bull' | 'bear' | 'none';
}

interface RangeInfo {
  isRange: boolean;
  support: number;
  resistance: number;
  width: number;
  widthPct: number;
  position: 'near-support' | 'near-resistance' | 'middle';
  touches: number;
  lookbackBars: number;
}

interface RapidAnalysis {
  symbol: string;
  currentPrice: number;
  timestamp: number;
  signals: RapidSignal[];
  confluence: { long: number; short: number };
  indicatorState: IndicatorState;
  score: ScoreBreakdown;
  rangeInfo: RangeInfo;
  suggestion: {
    direction: 'long' | 'short' | 'none';
    entry: number;
    stop: number;
    target: number;
    confidence: number;
    score: number;
    sources: string[];
    reason: string;
    mode: 'trend' | 'range';
  };
  recentSignals: RapidSignal[];
  cached: boolean;
}

const SOURCE_NAMES: Record<string, string> = {
  'ema-cross': 'EMA交叉',
  'bollinger': '布林带',
  'rsi': 'RSI',
  'macd-flip': 'MACD',
  'divergence': '背离',
};

const SCORE_THRESHOLD = 70;
const RANGE_SCORE_THRESHOLD = 45;

export default function RapidSignalCard({ symbol = 'ETHUSDT' }: { symbol?: string }) {
  const [data, setData] = useState<RapidAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const prevDirectionRef = useRef<string>('none');
  const interval = useChartStore((s) => s.interval);

  const fetchSignal = useCallback(async () => {
    try {
      const json = await apiGet<RapidAnalysis>(`/api/rapid-signals?symbol=${symbol}&timeframe=${interval}`);
      setData(json);
      setError(null);

      // 声音提醒：检测方向变化
      const newDir = json.suggestion.direction;
      if (soundEnabled && newDir !== 'none' && newDir !== prevDirectionRef.current) {
        if (newDir === 'long') playLongSound();
        else if (newDir === 'short') playShortSound();
      }
      prevDirectionRef.current = newDir;
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [symbol, interval, soundEnabled]);

  useEffect(() => {
    fetchSignal();
    if (!autoRefresh) return;
    const timer = setInterval(fetchSignal, 15000);
    return () => clearInterval(timer);
  }, [fetchSignal, autoRefresh]);

  if (loading && !data) {
    return (
      <div className="glass-card p-6">
        <div className="animate-pulse text-dark-500">加载快速信号...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="glass-card p-6">
        <div className="text-red-400 text-sm">信号拉取失败: {error}</div>
        <button
          onClick={fetchSignal}
          className="mt-2 text-xs text-blue-400 hover:text-blue-300 underline"
        >
          重试
        </button>
      </div>
    );
  }

  if (!data) return null;

  const s = data.suggestion;
  const sc = data.score;
  const ri = data.rangeInfo;
  const isLong = s.direction === 'long';
  const isShort = s.direction === 'short';
  const hasSignal = s.direction !== 'none';
  const ind = data.indicatorState;
  const scorePct = Math.min(100, sc.total);
  const isRangeMode = s.mode === 'range' || ri.isRange;

  // 评分进度条颜色 — 震荡模式用更低阈值
  const activeThreshold = isRangeMode ? RANGE_SCORE_THRESHOLD : SCORE_THRESHOLD;
  const scoreColor = sc.total >= activeThreshold
    ? (sc.direction === 'long' ? 'bg-green-500' : 'bg-red-500')
    : sc.total >= (isRangeMode ? 30 : 50)
    ? 'bg-amber-500'
    : 'bg-dark-600';

  return (
    <div className="glass-card overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-dark-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-white">⚡ 快速信号 v2</span>
          <span className="text-xs text-dark-500">{symbol} · {interval}</span>
          {isRangeMode && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-900/50 text-purple-400 font-bold">震荡</span>
          )}
          {data.cached && <span className="text-[10px] text-dark-600">缓存</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-dark-500">
            {new Date(data.timestamp).toLocaleTimeString('zh-CN')}
          </span>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`text-xs px-2 py-0.5 rounded ${
              autoRefresh ? 'bg-green-900/50 text-green-400' : 'bg-dark-800 text-dark-500'
            }`}
          >
            {autoRefresh ? '● 自动' : '○ 暂停'}
          </button>
          <button
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              if (next) playTestSound();
            }}
            className={`text-xs px-2 py-0.5 rounded ${
              soundEnabled ? 'bg-amber-900/50 text-amber-400' : 'bg-dark-800 text-dark-500'
            }`}
            title={soundEnabled ? '声音提醒已开启（做多升调/做空降调）' : '开启声音提醒'}
          >
            {soundEnabled ? '🔊 声音' : '🔇 静音'}
          </button>
          <button
            onClick={fetchSignal}
            className="text-xs text-dark-400 hover:text-white"
          >
            ↻
          </button>
        </div>
      </div>

      {/* 评分进度条 */}
      <div className="px-4 py-3 border-b border-dark-800">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-dark-500">信号评分</span>
          <span className={`text-lg font-black tabular-nums ${
            sc.total >= activeThreshold
              ? (sc.direction === 'long' ? 'text-green-400' : 'text-red-400')
              : sc.total >= (isRangeMode ? 30 : 50) ? 'text-amber-400' : 'text-dark-500'
          }`}>
            {sc.total}<span className="text-xs text-dark-600">/100</span>
          </span>
        </div>
        <div className="h-2 bg-dark-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${scoreColor}`}
            style={{ width: `${scorePct}%` }}
          />
        </div>
        {/* 评分明细 */}
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-dark-500">
          <span>趋势 <b className={sc.trend > 0 ? 'text-blue-400' : 'text-dark-600'}>{sc.trend}</b>/25</span>
          <span>动量 <b className={sc.momentum >= 20 ? 'text-green-400' : sc.momentum >= 10 ? 'text-amber-400' : 'text-dark-600'}>{sc.momentum}</b>/20</span>
          <span>波动 <b className={sc.bollinger >= 20 ? 'text-cyan-400' : sc.bollinger >= 10 ? 'text-amber-400' : 'text-dark-600'}>{sc.bollinger}</b>/20</span>
          <span>背离 <b className={sc.divergence > 0 ? 'text-purple-400' : 'text-dark-600'}>{sc.divergence}</b>/20</span>
          <span>量能 <b className={sc.volume >= 15 ? 'text-orange-400' : sc.volume >= 8 ? 'text-amber-400' : 'text-dark-600'}>{sc.volume}</b>/15</span>
        </div>
        {/* 阈值线 */}
        <div className="mt-1 text-[10px] text-dark-600">
          阈值 {activeThreshold} 分 {sc.total >= activeThreshold ? '✓ 已达标' : `差 ${activeThreshold - sc.total} 分`}{isRangeMode ? ' · 震荡模式' : ''}
        </div>
      </div>

      {/* 主信号区 */}
      <div className={`px-4 py-4 ${hasSignal ? (isLong ? 'bg-green-950/20' : 'bg-red-950/20') : ''}`}>
        {hasSignal ? (
          <div className="flex items-center justify-between">
            <div>
              <div className={`text-3xl font-black ${isLong ? 'text-green-400' : 'text-red-400'}`}>
                {isLong ? '做多 LONG' : '做空 SHORT'}
              </div>
              <div className="text-xs text-dark-500 mt-1">{s.reason}</div>
            </div>
            <div className="flex flex-col items-end gap-1">
              {s.sources.length > 0 && (
                <span className="text-xs text-amber-400">{s.sources.length}路共振</span>
              )}
              <span className="text-xs text-dark-500">评分 {s.score}</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-2">
            <span className="text-2xl font-bold text-dark-600">观望中</span>
            <span className="text-xs text-dark-700 ml-2">{s.reason}</span>
          </div>
        )}
      </div>

      {/* 入场/止损/止盈 */}
      {hasSignal && (
        <div className="grid grid-cols-3 gap-px bg-dark-800">
          <div className="bg-dark-900 px-3 py-2">
            <div className="text-xs text-dark-500">入场</div>
            <div className="text-lg font-bold text-white tabular-nums">{s.entry.toFixed(2)}</div>
          </div>
          <div className="bg-dark-900 px-3 py-2">
            <div className="text-xs text-red-400">止损</div>
            <div className="text-lg font-bold text-red-400 tabular-nums">{s.stop.toFixed(2)}</div>
            <div className="text-[10px] text-dark-600">
              {(Math.abs(s.entry - s.stop) / s.entry * 100).toFixed(2)}%
            </div>
          </div>
          <div className="bg-dark-900 px-3 py-2">
            <div className="text-xs text-green-400">止盈</div>
            <div className="text-lg font-bold text-green-400 tabular-nums">{s.target.toFixed(2)}</div>
            <div className="text-[10px] text-dark-600">
              {(Math.abs(s.target - s.entry) / s.entry * 100).toFixed(2)}%
            </div>
          </div>
        </div>
      )}

      {/* 震荡区间信息 */}
      {ri.isRange && (
        <div className="px-4 py-2 border-b border-dark-800 bg-purple-950/10">
          <div className="flex items-center justify-between text-xs">
            <span className="text-purple-400 font-bold">震荡区间</span>
            <span className="text-dark-500">触及{ri.touches}次 · {ri.widthPct}%</span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <div>
              <span className="text-dark-500">支撑 </span>
              <span className="font-bold text-green-400 tabular-nums">{ri.support.toFixed(2)}</span>
            </div>
            <div className="text-dark-600">←→</div>
            <div>
              <span className="text-dark-500">阻力 </span>
              <span className="font-bold text-red-400 tabular-nums">{ri.resistance.toFixed(2)}</span>
            </div>
          </div>
          {/* 价格位置指示器 */}
          <div className="mt-1.5 relative h-1.5 bg-dark-800 rounded-full">
            <div className="absolute h-full bg-purple-600/50 rounded-full"
              style={{ left: '5%', right: '5%' }} />
            <div className="absolute w-2 h-2 rounded-full bg-white -mt-0.25"
              style={{
                left: `calc(${Math.min(95, Math.max(5,
                  ri.width > 0 ? ((data.currentPrice - ri.support) / ri.width) * 100 : 50
                ))}% - 4px)`,
                top: '-1px',
              }} />
          </div>
          <div className="mt-1 text-[10px] text-center text-purple-400">
            {ri.position === 'near-support' && '⚡ 接近支撑 — 关注做多'}
            {ri.position === 'near-resistance' && '⚡ 接近阻力 — 关注做空'}
            {ri.position === 'middle' && '○ 区间中部 — 等待接近边界'}
          </div>
        </div>
      )}

      {/* 信号源标签 */}
      {hasSignal && (
        <div className="px-4 py-2 flex flex-wrap gap-1 border-b border-dark-800">
          {s.sources.map(src => (
            <span
              key={src}
              className={`text-[10px] px-2 py-0.5 rounded-full ${
                isLong ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
              }`}
            >
              {SOURCE_NAMES[src] || src}
            </span>
          ))}
        </div>
      )}

      {/* 指标状态（v2 扩展） */}
      <div className="px-4 py-3 border-b border-dark-800">
        <div className="text-xs text-dark-600 mb-2">指标状态</div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-dark-500">趋势(EMA50)</span>
            <span className={`font-mono ${
              ind.trend === 'up' ? 'text-green-400' : ind.trend === 'down' ? 'text-red-400' : 'text-dark-400'
            }`}>
              {ind.trend === 'up' ? '↑ 多头' : ind.trend === 'down' ? '↓ 空头' : '─ 震荡'} {ind.ema50.toFixed(1)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-dark-500">EMA 9/21</span>
            <span className={`font-mono ${ind.emaCross === 'up' ? 'text-green-400' : ind.emaCross === 'down' ? 'text-red-400' : 'text-dark-500'}`}>
              {ind.emaCross === 'up' ? '↑' : ind.emaCross === 'down' ? '↓' : '─'} {ind.ema9.toFixed(0)}/{ind.ema21.toFixed(0)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-dark-500">RSI(14)</span>
            <span className={`font-mono ${ind.rsiState === 'oversold' ? 'text-green-400' : ind.rsiState === 'overbought' ? 'text-red-400' : 'text-dark-400'}`}>
              {ind.rsi.toFixed(1)} {ind.rsiState !== 'neutral' ? (ind.rsiState === 'oversold' ? '←超卖' : '←超买') : ''}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-dark-500">布林(20,2)</span>
            <span className={`font-mono ${ind.bollingerPosition === 'below-lower' ? 'text-green-400' : ind.bollingerPosition === 'above-upper' ? 'text-red-400' : 'text-dark-400'}`}>
              {ind.bollingerPosition === 'below-lower' ? '破下轨' : ind.bollingerPosition === 'above-upper' ? '破上轨' : '带内'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-dark-500">MACD</span>
            <span className={`font-mono ${ind.macdHist > 0 ? 'text-green-400' : 'text-red-400'}`}>
              {ind.macdHist.toFixed(4)} {ind.macdHistTrend === 'rising' ? '↑' : ind.macdHistTrend === 'falling' ? '↓' : '─'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-dark-500">成交量</span>
            <span className={`font-mono ${
              ind.currentVolume > ind.volumeAvg * 1.5 ? 'text-orange-400' : 
              ind.currentVolume > ind.volumeAvg ? 'text-amber-400' : 'text-dark-400'
            }`}>
              {(ind.volumeAvg > 0 ? (ind.currentVolume / ind.volumeAvg).toFixed(2) : '0')}x
            </span>
          </div>
        </div>
        {/* 背离状态 */}
        {(ind.rsiDivergence !== 'none' || ind.macdDivergence !== 'none') && (
          <div className="mt-2 flex flex-wrap gap-1">
            {ind.rsiDivergence === 'bull' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-400">RSI 底背离</span>
            )}
            {ind.rsiDivergence === 'bear' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/40 text-red-400">RSI 顶背离</span>
            )}
            {ind.macdDivergence === 'bull' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/40 text-green-400">MACD 底背离</span>
            )}
            {ind.macdDivergence === 'bear' && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-900/40 text-red-400">MACD 顶背离</span>
            )}
          </div>
        )}
        <div className="mt-2 text-[10px] text-dark-600">
          ATR: {ind.atr.toFixed(2)} · 现价: {ind.price.toFixed(2)}
        </div>
      </div>

      {/* 最近信号历史 */}
      {data.recentSignals && data.recentSignals.length > 0 && (
        <div className="px-4 py-2">
          <div className="text-xs text-dark-600 mb-1">最近信号</div>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {data.recentSignals.slice(-5).reverse().map(sig => (
              <div key={sig.id} className="flex items-center justify-between text-[10px]">
                <span className={`font-mono ${sig.direction === 'long' ? 'text-green-500' : 'text-red-500'}`}>
                  {sig.direction === 'long' ? '多' : '空'} {SOURCE_NAMES[sig.source] || sig.source}
                </span>
                <span className="text-dark-600">
                  {new Date(sig.time * 1000).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', month: 'numeric', day: 'numeric' })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="px-4 py-1 text-[10px] text-red-500 border-t border-dark-800">
          上次刷新失败: {error}
        </div>
      )}
    </div>
  );
}
