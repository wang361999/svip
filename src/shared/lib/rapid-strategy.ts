/**
 * 快速多空策略引擎 · Rapid Strategy Engine
 *
 * 设计目标：
 *   - 多空双吃（多头空头都能做）
 *   - 高频率（15m 周期，日均 5~15 个信号）
 *   - 随时进出（反向信号 = 平仓反手）
 *   - 4 路独立信号源，互不依赖
 *
 * 4 路信号触发器（15 分钟周期）：
 *   1. EMA9/EMA21 交叉 → 趋势动量
 *   2. 布林带触碰(20, 2σ) → 均值回归
 *   3. RSI(14) 极值 → 超买超卖
 *   4. MACD 柱状图翻转 → 动量转向
 *
 * 退出规则：
 *   - 止损：1.5×ATR(14, 15m)
 *   - 止盈：1.5×ATR（单信号）/ 2×ATR（2+ 信号共振）
 *   - 反向信号：新反向信号出现 = 平仓 + 反手
 *   - 时间退出：1 小时（4 根 15m K 线）
 */

// ==================== 类型定义 ====================

export interface KlineData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SignalSource = 'ema-cross' | 'bollinger' | 'rsi' | 'macd-flip';
export type Direction = 'long' | 'short';

export interface RapidSignal {
  id: string;
  source: SignalSource;
  direction: Direction;
  entry: number;
  stop: number;
  target: number;
  atr: number;
  confidence: number;
  confluenceSources: SignalSource[];
  time: number;
  reason: string;
  barIndex: number;
}

export interface IndicatorState {
  ema9: number;
  ema21: number;
  emaCross: 'up' | 'down' | 'none';
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
}

export interface RapidAnalysis {
  symbol: string;
  currentPrice: number;
  timestamp: number;
  signals: RapidSignal[];
  confluence: { long: number; short: number };
  indicatorState: IndicatorState;
  suggestion: {
    direction: Direction | 'none';
    entry: number;
    stop: number;
    target: number;
    confidence: number;
    sources: SignalSource[];
    reason: string;
  };
  recentSignals: RapidSignal[];
}

// ==================== 策略参数 ====================

export const RAPID_CONFIG = {
  timeframe: '15m' as const,
  emaFast: 9,
  emaSlow: 21,
  bollingerPeriod: 20,
  bollingerStd: 2,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atrPeriod: 14,
  stopATRMult: 1.5,
  targetATRMult: 1.5,
  confluenceTargetMult: 2.0,
  timeExitBars: 4,
  minKlines: 60,
};

// ==================== 指标计算 ====================

function emaSeries(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = values[0];
  result.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

function bollingerBands(klines: KlineData[], period: number, stdDev: number) {
  const closes = klines.map(k => k.close);
  const upper: number[] = [];
  const middle: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(NaN);
      middle.push(NaN);
      lower.push(NaN);
      continue;
    }
    const slice = closes.slice(i - period + 1, i + 1);
    const mid = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + (v - mid) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push(mid + sd * stdDev);
    middle.push(mid);
    lower.push(mid - sd * stdDev);
  }
  return { upper, middle, lower };
}

function rsiSeries(klines: KlineData[], period: number): number[] {
  const result: number[] = [50];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i < klines.length; i++) {
    const change = klines[i].close - klines[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push(100 - 100 / (1 + rs));
      } else {
        result.push(50);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + rs));
    }
  }
  return result;
}

function macdData(klines: KlineData[], fastP: number, slowP: number, signalP: number) {
  const closes = klines.map(k => k.close);
  const emaFast = emaSeries(closes, fastP);
  const emaSlow = emaSeries(closes, slowP);
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    dif.push(emaFast[i] - emaSlow[i]);
  }
  const signal = emaSeries(dif, signalP);
  const hist: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    hist.push(dif[i] - signal[i]);
  }
  return { dif, signal, hist };
}

function atrSeries(klines: KlineData[], period: number): number[] {
  const tr: number[] = [];
  for (let i = 0; i < klines.length; i++) {
    if (i === 0) {
      tr.push(klines[i].high - klines[i].low);
    } else {
      const h = klines[i].high;
      const l = klines[i].low;
      const pc = klines[i - 1].close;
      tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  const result: number[] = [tr[0]];
  for (let i = 1; i < tr.length; i++) {
    const prev = result[result.length - 1];
    result.push((prev * (period - 1) + tr[i]) / period);
  }
  return result;
}

// ==================== 4 路信号检测器 ====================

function detectEMACross(
  klines: KlineData[],
  i: number,
  ema9: number[],
  ema21: number[],
): RapidSignal | null {
  if (i < 1) return null;
  const prevDiff = ema9[i - 1] - ema21[i - 1];
  const currDiff = ema9[i] - ema21[i];

  if (prevDiff <= 0 && currDiff > 0) {
    return {
      id: `ema-cross-long-${klines[i].time}`,
      source: 'ema-cross',
      direction: 'long',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['ema-cross'],
      time: klines[i].time,
      reason: 'EMA9 上穿 EMA21（金叉）',
      barIndex: i,
    };
  }

  if (prevDiff >= 0 && currDiff < 0) {
    return {
      id: `ema-cross-short-${klines[i].time}`,
      source: 'ema-cross',
      direction: 'short',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['ema-cross'],
      time: klines[i].time,
      reason: 'EMA9 下穿 EMA21（死叉）',
      barIndex: i,
    };
  }
  return null;
}

function detectBollinger(
  klines: KlineData[],
  i: number,
  bb: { upper: number[]; middle: number[]; lower: number[] },
): RapidSignal | null {
  if (i < 1 || isNaN(bb.lower[i]) || isNaN(bb.upper[i])) return null;
  const close = klines[i].close;
  const prevClose = klines[i - 1].close;

  if (close < bb.lower[i] && prevClose >= bb.lower[i - 1]) {
    return {
      id: `bollinger-long-${klines[i].time}`,
      source: 'bollinger',
      direction: 'long',
      entry: close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['bollinger'],
      time: klines[i].time,
      reason: '收盘价跌破布林带下轨（超卖回归）',
      barIndex: i,
    };
  }

  if (close > bb.upper[i] && prevClose <= bb.upper[i - 1]) {
    return {
      id: `bollinger-short-${klines[i].time}`,
      source: 'bollinger',
      direction: 'short',
      entry: close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['bollinger'],
      time: klines[i].time,
      reason: '收盘价突破布林带上轨（超买回归）',
      barIndex: i,
    };
  }
  return null;
}

function detectRSI(
  klines: KlineData[],
  i: number,
  rsi: number[],
): RapidSignal | null {
  if (i < 1 || rsi[i] === 50) return null;

  if (rsi[i] < RAPID_CONFIG.rsiOversold && rsi[i - 1] >= RAPID_CONFIG.rsiOversold) {
    return {
      id: `rsi-long-${klines[i].time}`,
      source: 'rsi',
      direction: 'long',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['rsi'],
      time: klines[i].time,
      reason: `RSI=${rsi[i].toFixed(1)} 进入超卖区（<${RAPID_CONFIG.rsiOversold}）`,
      barIndex: i,
    };
  }

  if (rsi[i] > RAPID_CONFIG.rsiOverbought && rsi[i - 1] <= RAPID_CONFIG.rsiOverbought) {
    return {
      id: `rsi-short-${klines[i].time}`,
      source: 'rsi',
      direction: 'short',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['rsi'],
      time: klines[i].time,
      reason: `RSI=${rsi[i].toFixed(1)} 进入超买区（>${RAPID_CONFIG.rsiOverbought}）`,
      barIndex: i,
    };
  }
  return null;
}

function detectMACDFlip(
  klines: KlineData[],
  i: number,
  hist: number[],
): RapidSignal | null {
  if (i < 1) return null;

  if (hist[i - 1] <= 0 && hist[i] > 0) {
    return {
      id: `macd-flip-long-${klines[i].time}`,
      source: 'macd-flip',
      direction: 'long',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['macd-flip'],
      time: klines[i].time,
      reason: 'MACD 柱状图从负转正（动量转多）',
      barIndex: i,
    };
  }

  if (hist[i - 1] >= 0 && hist[i] < 0) {
    return {
      id: `macd-flip-short-${klines[i].time}`,
      source: 'macd-flip',
      direction: 'short',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 1,
      confluenceSources: ['macd-flip'],
      time: klines[i].time,
      reason: 'MACD 柱状图从正转负（动量转空）',
      barIndex: i,
    };
  }
  return null;
}

// ==================== 主分析函数 ====================

export function analyzeRapid(
  symbol: string,
  klines: KlineData[],
): RapidAnalysis {
  const n = klines.length;
  const now = Date.now();

  if (n < RAPID_CONFIG.minKlines) {
    return emptyResult(symbol, klines, now);
  }

  const closes = klines.map(k => k.close);
  const ema9 = emaSeries(closes, RAPID_CONFIG.emaFast);
  const ema21 = emaSeries(closes, RAPID_CONFIG.emaSlow);
  const bb = bollingerBands(klines, RAPID_CONFIG.bollingerPeriod, RAPID_CONFIG.bollingerStd);
  const rsi = rsiSeries(klines, RAPID_CONFIG.rsiPeriod);
  const macd = macdData(klines, RAPID_CONFIG.macdFast, RAPID_CONFIG.macdSlow, RAPID_CONFIG.macdSignal);
  const atr = atrSeries(klines, RAPID_CONFIG.atrPeriod);

  const lookback = 20;
  const startIdx = Math.max(1, n - lookback);
  const allSignals: RapidSignal[] = [];

  for (let i = startIdx; i < n; i++) {
    const detectors = [
      detectEMACross(klines, i, ema9, ema21),
      detectBollinger(klines, i, bb),
      detectRSI(klines, i, rsi),
      detectMACDFlip(klines, i, macd.hist),
    ];

    for (const sig of detectors) {
      if (sig) allSignals.push(sig);
    }
  }

  const currentATR = atr[n - 1];
  const currentPrice = klines[n - 1].close;

  for (const sig of allSignals) {
    sig.atr = currentATR;
    sig.stop = sig.direction === 'long'
      ? sig.entry - RAPID_CONFIG.stopATRMult * currentATR
      : sig.entry + RAPID_CONFIG.stopATRMult * currentATR;
    sig.target = sig.direction === 'long'
      ? sig.entry + RAPID_CONFIG.targetATRMult * currentATR
      : sig.entry - RAPID_CONFIG.targetATRMult * currentATR;
  }

  const latestBar = n - 1;
  // 2根K线窗口：最新 + 前1根，捕捉跨K线共振
  const currentSignals = allSignals.filter(s => s.barIndex === latestBar);
  const recentWindow = allSignals.filter(s => s.barIndex >= latestBar - 1);
  const longSources = new Set<SignalSource>();
  const shortSources = new Set<SignalSource>();

  for (const s of recentWindow) {
    if (s.direction === 'long') longSources.add(s.source);
    else shortSources.add(s.source);
  }

  const merged = mergeConfluence(currentSignals, recentWindow, currentATR, currentPrice, latestBar, klines);

  const indicatorState: IndicatorState = {
    ema9: round(ema9[n - 1], 2),
    ema21: round(ema21[n - 1], 2),
    emaCross: ema9[n - 1] > ema21[n - 1] ? 'up' : ema9[n - 1] < ema21[n - 1] ? 'down' : 'none',
    bollingerUpper: round(bb.upper[n - 1], 2),
    bollingerMiddle: round(bb.middle[n - 1], 2),
    bollingerLower: round(bb.lower[n - 1], 2),
    bollingerPosition: currentPrice > bb.upper[n - 1] ? 'above-upper'
      : currentPrice < bb.lower[n - 1] ? 'below-lower' : 'middle',
    rsi: round(rsi[n - 1], 1),
    rsiState: rsi[n - 1] < RAPID_CONFIG.rsiOversold ? 'oversold'
      : rsi[n - 1] > RAPID_CONFIG.rsiOverbought ? 'overbought' : 'neutral',
    macdHist: round(macd.hist[n - 1], 4),
    macdHistTrend: macd.hist[n - 1] > macd.hist[n - 2] ? 'rising'
      : macd.hist[n - 1] < macd.hist[n - 2] ? 'falling' : 'flat',
    atr: round(currentATR, 2),
    price: currentPrice,
  };

  const longCount = longSources.size;
  const shortCount = shortSources.size;
  const winningDir = longCount > shortCount ? 'long' : shortCount > longCount ? 'short' : 'none';
  const confidence = Math.max(longCount, shortCount);
  const winningSources = winningDir === 'long'
    ? Array.from(longSources) : Array.from(shortSources);

  // 最低2路共振才出信号，单信号不触发
  const suggestion = winningDir !== 'none' && confidence >= 2
    ? {
        direction: winningDir as Direction,
        entry: currentPrice,
        stop: winningDir === 'long'
          ? currentPrice - RAPID_CONFIG.stopATRMult * currentATR
          : currentPrice + RAPID_CONFIG.stopATRMult * currentATR,
        target: confidence >= 2
          ? (winningDir === 'long'
            ? currentPrice + RAPID_CONFIG.confluenceTargetMult * currentATR
            : currentPrice - RAPID_CONFIG.confluenceTargetMult * currentATR)
          : (winningDir === 'long'
            ? currentPrice + RAPID_CONFIG.targetATRMult * currentATR
            : currentPrice - RAPID_CONFIG.targetATRMult * currentATR),
        confidence,
        sources: winningSources,
        reason: buildReason(winningDir, winningSources),
      }
    : { direction: 'none' as const, entry: 0, stop: 0, target: 0, confidence: 0, sources: [], reason: '无共振信号，观望' };

  return {
    symbol,
    currentPrice,
    timestamp: now,
    signals: merged,
    confluence: { long: longCount, short: shortCount },
    indicatorState,
    suggestion,
    recentSignals: allSignals.slice(-10),
  };
}

// ==================== 辅助函数 ====================

function mergeConfluence(
  currentSignals: RapidSignal[],
  recentWindow: RapidSignal[],
  atr: number,
  price: number,
  barIndex: number,
  klines: KlineData[],
): RapidSignal[] {
  if (currentSignals.length === 0) {
    const longSources = new Set<SignalSource>();
    const shortSources = new Set<SignalSource>();
    for (const s of recentWindow) {
      if (s.direction === 'long') longSources.add(s.source);
      else shortSources.add(s.source);
    }
    const result: RapidSignal[] = [];

    if (longSources.size > 0) {
      const sources = Array.from(longSources);
      result.push(createMergedSignal('long', sources, price, atr, barIndex, klines));
    }
    if (shortSources.size > 0) {
      const sources = Array.from(shortSources);
      result.push(createMergedSignal('short', sources, price, atr, barIndex, klines));
    }
    return result;
  }

  const longSignals = currentSignals.filter(s => s.direction === 'long');
  const shortSignals = currentSignals.filter(s => s.direction === 'short');

  for (const s of recentWindow) {
    if (s.barIndex < barIndex) {
      if (s.direction === 'long') longSignals.push(s);
      else shortSignals.push(s);
    }
  }

  const result: RapidSignal[] = [];

  if (longSignals.length > 0) {
    const sources = Array.from(new Set(longSignals.map(s => s.source)));
    result.push(createMergedSignal('long', sources, price, atr, barIndex, klines));
  }

  if (shortSignals.length > 0) {
    const sources = Array.from(new Set(shortSignals.map(s => s.source)));
    result.push(createMergedSignal('short', sources, price, atr, barIndex, klines));
  }

  return result;
}

function createMergedSignal(
  dir: Direction,
  sources: SignalSource[],
  price: number,
  atr: number,
  barIndex: number,
  klines: KlineData[],
): RapidSignal {
  const confidence = sources.length;
  const useConfluence = confidence >= 2;
  const targetMult = useConfluence ? RAPID_CONFIG.confluenceTargetMult : RAPID_CONFIG.targetATRMult;

  return {
    id: `rapid-${dir}-${klines[barIndex].time}`,
    source: sources[0],
    direction: dir,
    entry: price,
    stop: dir === 'long'
      ? price - RAPID_CONFIG.stopATRMult * atr
      : price + RAPID_CONFIG.stopATRMult * atr,
    target: dir === 'long'
      ? price + targetMult * atr
      : price - targetMult * atr,
    atr,
    confidence,
    confluenceSources: sources,
    time: klines[barIndex].time,
    reason: buildReason(dir, sources),
    barIndex,
  };
}

function buildReason(dir: Direction, sources: SignalSource[]): string {
  const dirText = dir === 'long' ? '做多' : '做空';
  const sourceNames: Record<SignalSource, string> = {
    'ema-cross': 'EMA交叉',
    'bollinger': '布林带',
    'rsi': 'RSI极值',
    'macd-flip': 'MACD翻转',
  };
  const sourceText = sources.map(s => sourceNames[s]).join(' + ');
  const confluenceText = sources.length >= 2 ? `${sources.length}路共振` : '单信号';
  return `${dirText} · ${confluenceText} · ${sourceText}`;
}

function emptyResult(symbol: string, klines: KlineData[], now: number): RapidAnalysis {
  const price = klines.length > 0 ? klines[klines.length - 1].close : 0;
  return {
    symbol,
    currentPrice: price,
    timestamp: now,
    signals: [],
    confluence: { long: 0, short: 0 },
    indicatorState: {
      ema9: 0, ema21: 0, emaCross: 'none',
      bollingerUpper: 0, bollingerMiddle: 0, bollingerLower: 0, bollingerPosition: 'middle',
      rsi: 50, rsiState: 'neutral',
      macdHist: 0, macdHistTrend: 'flat',
      atr: 0, price,
    },
    suggestion: { direction: 'none', entry: 0, stop: 0, target: 0, confidence: 0, sources: [], reason: 'K 线数据不足' },
    recentSignals: [],
  };
}

function round(n: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
}
