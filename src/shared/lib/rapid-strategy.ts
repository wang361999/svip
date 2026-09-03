/**
 * 快速多空策略引擎 · Rapid Strategy Engine v2
 *
 * v2 优化：
 *   1. EMA50 趋势过滤器 — 顺势信号，过滤逆势假信号
 *   2. 成交量确认 — 布林带突破需放量才算有效
 *   3. RSI/MACD 背离检测 — 捕捉顶底反转
 *   4. 0~100 信号评分制 — 多因子加权，>70 分才出信号
 *   5. 信号冷却期 — 同方向 3 根 K 线内不重复触发
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

export type SignalSource = 'ema-cross' | 'bollinger' | 'rsi' | 'macd-flip' | 'divergence';
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

export interface ScoreBreakdown {
  trend: number;        // 趋势分 (0-25)
  momentum: number;     // 动量分 (0-20)
  bollinger: number;    // 波动分 (0-20)
  divergence: number;   // 背离分 (0-20)
  volume: number;       // 成交量分 (0-15)
  total: number;        // 总分 (0-100)
  direction: Direction | 'none';
}

export interface IndicatorState {
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

export interface RangeInfo {
  isRange: boolean;
  support: number;       // 区间下沿
  resistance: number;    // 区间上沿
  width: number;         // 区间宽度
  widthPct: number;      // 宽度百分比
  position: 'near-support' | 'near-resistance' | 'middle';
  touches: number;       // 触及次数
  lookbackBars: number;  // 检测窗口
}

export interface RapidAnalysis {
  symbol: string;
  currentPrice: number;
  timestamp: number;
  signals: RapidSignal[];
  confluence: { long: number; short: number };
  indicatorState: IndicatorState;
  score: ScoreBreakdown;
  rangeInfo: RangeInfo;
  suggestion: {
    direction: Direction | 'none';
    entry: number;
    stop: number;
    target: number;
    confidence: number;
    score: number;
    sources: SignalSource[];
    reason: string;
    mode: 'trend' | 'range';
  };
  recentSignals: RapidSignal[];
}

// ==================== 策略参数 ====================

export const RAPID_CONFIG = {
  timeframe: '15m' as const,
  emaFast: 9,
  emaSlow: 21,
  emaTrend: 50,            // 趋势过滤 EMA
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
  targetATRMult: 2.0,
  confluenceTargetMult: 2.5,
  timeExitBars: 4,
  minKlines: 60,
  // v2 新增
  volumeAvgPeriod: 20,      // 成交量均线周期
  volumeBreakoutMult: 1.5,  // 放量突破倍数
  divergenceLookback: 20,   // 背离回溯根数
  cooldownBars: 3,          // 同方向冷却 K 线数
  scoreThreshold: 70,       // 趋势模式出信号最低分数
  rangeScoreThreshold: 45, // 震荡模式出信号最低分数
  useTrendFilter: true,     // 是否启用趋势过滤
  // v3 震荡区间参数
  rangeLookback: 30,        // 震荡检测窗口
  rangeMaxWidthPct: 3.0,    // 最大宽度百分比（超过则不算震荡）
  rangeMinTouches: 3,       // 最少触及次数
  rangeProximityPct: 0.3,   // 接近边界的百分比
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

// ==================== v2 新增：成交量均线 ====================

function volumeAvgSeries(klines: KlineData[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < klines.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += klines[j].volume;
    result.push(sum / period);
  }
  return result;
}

// ==================== v2 新增：背离检测 ====================

// RSI 背离：价格创新低但 RSI 没创新低 → 看多背离
//          价格创新高但 RSI 没创新高 → 看空背离
function detectRSIDivergence(
  klines: KlineData[],
  rsi: number[],
  lookback: number,
  currentIdx: number,
): 'bull' | 'bear' | 'none' {
  if (currentIdx < lookback + 2) return 'none';
  const start = currentIdx - lookback;
  if (start < 1) return 'none';

  // 找区间内价格的最低点和最高点
  let minPriceIdx = start;
  let maxPriceIdx = start;
  for (let i = start + 1; i <= currentIdx; i++) {
    if (klines[i].low < klines[minPriceIdx].low) minPriceIdx = i;
    if (klines[i].high > klines[maxPriceIdx].high) maxPriceIdx = i;
  }

  // 看多背离：当前价格接近区间最低点，但 RSI 比之前的最低点更高
  const recentLowIdx = minPriceIdx;
  // 在 recentLowIdx 之前找另一个低点
  let prevLowIdx = -1;
  for (let i = start; i < recentLowIdx - 2; i++) {
    if (klines[i].low <= klines[recentLowIdx].low * 1.002) {
      prevLowIdx = i;
      break;
    }
  }
  if (prevLowIdx >= 0 && rsi[prevLowIdx] !== undefined && rsi[recentLowIdx] !== undefined) {
    // 价格创新低或接近前低，但 RSI 没创新低
    if (rsi[recentLowIdx] > rsi[prevLowIdx] + 2) return 'bull';
  }

  // 看空背离：当前价格接近区间最高点，但 RSI 比之前的最高点更低
  const recentHighIdx = maxPriceIdx;
  let prevHighIdx = -1;
  for (let i = start; i < recentHighIdx - 2; i++) {
    if (klines[i].high >= klines[recentHighIdx].high * 0.998) {
      prevHighIdx = i;
      break;
    }
  }
  if (prevHighIdx >= 0 && rsi[prevHighIdx] !== undefined && rsi[recentHighIdx] !== undefined) {
    // 价格创新高或接近前高，但 RSI 没创新高
    if (rsi[recentHighIdx] < rsi[prevHighIdx] - 2) return 'bear';
  }

  return 'none';
}

// MACD 背离：价格创新低但 MACD 柱没创新低 → 看多
//           价格创新高但 MACD 柱没创新高 → 看空
function detectMACDDivergence(
  klines: KlineData[],
  hist: number[],
  lookback: number,
  currentIdx: number,
): 'bull' | 'bear' | 'none' {
  if (currentIdx < lookback + 2) return 'none';
  const start = currentIdx - lookback;
  if (start < 1) return 'none';

  let minPriceIdx = start;
  let maxPriceIdx = start;
  for (let i = start + 1; i <= currentIdx; i++) {
    if (klines[i].low < klines[minPriceIdx].low) minPriceIdx = i;
    if (klines[i].high > klines[maxPriceIdx].high) maxPriceIdx = i;
  }

  // 看多背离
  const recentLowIdx = minPriceIdx;
  let prevLowIdx = -1;
  for (let i = start; i < recentLowIdx - 2; i++) {
    if (klines[i].low <= klines[recentLowIdx].low * 1.002) {
      prevLowIdx = i;
      break;
    }
  }
  if (prevLowIdx >= 0 && hist[prevLowIdx] !== undefined && hist[recentLowIdx] !== undefined) {
    if (hist[recentLowIdx] > hist[prevLowIdx]) return 'bull';
  }

  // 看空背离
  const recentHighIdx = maxPriceIdx;
  let prevHighIdx = -1;
  for (let i = start; i < recentHighIdx - 2; i++) {
    if (klines[i].high >= klines[recentHighIdx].high * 0.998) {
      prevHighIdx = i;
      break;
    }
  }
  if (prevHighIdx >= 0 && hist[prevHighIdx] !== undefined && hist[recentHighIdx] !== undefined) {
    if (hist[recentHighIdx] < hist[prevHighIdx]) return 'bear';
  }

  return 'none';
}

// ==================== v3 新增：震荡区间检测 ====================

function detectRange(klines: KlineData[], atrVal: number): RangeInfo {
  const n = klines.length;
  const lookback = Math.min(RAPID_CONFIG.rangeLookback, n - 1);
  if (lookback < 5) {
    return { isRange: false, support: 0, resistance: 0, width: 0, widthPct: 0, position: 'middle', touches: 0, lookbackBars: lookback };
  }

  const start = n - lookback;
  const window = klines.slice(start);

  // 找区间最高点和最低点
  let maxHigh = -Infinity, minLow = Infinity;
  let maxHighIdx = 0, minLowIdx = 0;
  for (let i = 0; i < window.length; i++) {
    if (window[i].high > maxHigh) { maxHigh = window[i].high; maxHighIdx = i; }
    if (window[i].low < minLow) { minLow = window[i].low; minLowIdx = i; }
  }

  const width = maxHigh - minLow;
  const midPrice = (maxHigh + minLow) / 2;
  const widthPct = midPrice > 0 ? (width / midPrice) * 100 : 0;

  // 统计触及上沿和下沿的次数
  const tolerance = Math.max(width * 0.05, atrVal * 0.3); // 容差：区间宽度5%或ATR的30%
  let touches = 0;
  let supportTouches = 0;
  let resistanceTouches = 0;
  for (let i = 0; i < window.length; i++) {
    const nearSupport = Math.abs(window[i].low - minLow) < tolerance;
    const nearResistance = Math.abs(window[i].high - maxHigh) < tolerance;
    if (nearSupport) { touches++; supportTouches++; }
    if (nearResistance) { touches++; resistanceTouches++; }
  }

  // 判定为震荡的条件：
  // 1. 宽度百分比 < 3%（加密货币 30根K线内波动不大）
  // 2. 至少触及边界3次（有来回）
  // 3. 上下沿各有至少1次触及
  const isRange = widthPct <= RAPID_CONFIG.rangeMaxWidthPct
    && touches >= RAPID_CONFIG.rangeMinTouches
    && supportTouches >= 1
    && resistanceTouches >= 1;

  // 当前价格在区间中的位置
  const currentPrice = klines[n - 1].close;
  const proximityThreshold = width * RAPID_CONFIG.rangeProximityPct;
  let position: 'near-support' | 'near-resistance' | 'middle';
  if (currentPrice - minLow < proximityThreshold) {
    position = 'near-support';
  } else if (maxHigh - currentPrice < proximityThreshold) {
    position = 'near-resistance';
  } else {
    position = 'middle';
  }

  return {
    isRange,
    support: round(minLow, 2),
    resistance: round(maxHigh, 2),
    width: round(width, 2),
    widthPct: round(widthPct, 2),
    position,
    touches,
    lookbackBars: lookback,
  };
}

// ==================== v2 新增：信号评分系统 ====================

function calcSignalScore(
  klines: KlineData[],
  i: number,
  ctx: {
    ema50: number[]; ema9: number[]; ema21: number[];
    bb: { upper: number[]; middle: number[]; lower: number[] };
    rsi: number[]; macd: { hist: number[] }; atr: number[];
    volAvg: number[]; rsiDiv: 'bull' | 'bear' | 'none'; macdDiv: 'bull' | 'bear' | 'none';
  },
): ScoreBreakdown {
  const price = klines[i].close;
  const ema50Val = ctx.ema50[i];
  const ema9Val = ctx.ema9[i];
  const ema21Val = ctx.ema21[i];
  const bbU = ctx.bb.upper[i];
  const bbL = ctx.bb.lower[i];
  const bbM = ctx.bb.middle[i];
  const rsiVal = ctx.rsi[i];
  const histVal = ctx.macd.hist[i];
  const prevHist = ctx.macd.hist[i - 1] || 0;
  const vol = klines[i].volume;
  const vAvg = ctx.volAvg[i] || vol;
  const atrVal = ctx.atr[i] || 0;

  let longScore = 0;
  let shortScore = 0;

  // 1. 趋势分 (25分)：价格 vs EMA50
  if (price > ema50Val) {
    longScore += 25;
  } else if (price < ema50Val) {
    shortScore += 25;
  }

  // 2. 动量分 (20分)：MACD 柱状图方向和强度
  if (histVal > 0 && histVal >= prevHist) {
    longScore += 20;  // 正且增大
  } else if (histVal < 0 && histVal <= prevHist) {
    shortScore += 20; // 负且减小
  } else if (histVal > 0 && histVal < prevHist) {
    longScore += 10;  // 正但减弱
  } else if (histVal < 0 && histVal > prevHist) {
    shortScore += 10; // 负但减弱
  }

  // 3. 波动分 (20分)：布林带位置
  if (!isNaN(bbL) && !isNaN(bbU)) {
    const bbWidth = bbU - bbL;
    if (bbWidth > 0) {
      const pctB = (price - bbL) / bbWidth; // 0~1，越接近0越靠近下轨
      if (pctB < 0.15) {
        longScore += 20;  // 接近下轨
      } else if (pctB > 0.85) {
        shortScore += 20; // 接近上轨
      } else if (pctB < 0.35) {
        longScore += 10;  // 偏下
      } else if (pctB > 0.65) {
        shortScore += 10; // 偏上
      }
    }
  }

  // 4. 背离分 (20分)：RSI 或 MACD 背离，单个背离12分，双重背离封顶20分
  let divLong = 0, divShort = 0;
  if (ctx.rsiDiv === 'bull') divLong += 12;
  if (ctx.macdDiv === 'bull') divLong += 12;
  if (ctx.rsiDiv === 'bear') divShort += 12;
  if (ctx.macdDiv === 'bear') divShort += 12;
  // 双重背离是更强的信号，但背离总分封顶20分
  longScore += Math.min(divLong, 20);
  shortScore += Math.min(divShort, 20);

  // 5. 成交量分 (15分)：放量确认
  if (vAvg > 0) {
    const volRatio = vol / vAvg;
    if (volRatio >= 1.5) {
      // 放量，确认当前价格方向
      if (price > klines[i - 1]?.close || 0) longScore += 15;
      else shortScore += 15;
    } else if (volRatio >= 1.0) {
      if (price > klines[i - 1]?.close || 0) longScore += 8;
      else shortScore += 8;
    }
  }

  const direction = longScore > shortScore ? 'long' : shortScore > longScore ? 'short' : 'none';
  const total = Math.max(longScore, shortScore);

  return {
    trend: longScore > shortScore ? (price > ema50Val ? 25 : 0) : (price < ema50Val ? 25 : 0),
    momentum: direction === 'long' ? (histVal > 0 ? (histVal >= prevHist ? 20 : 10) : 0) : (histVal < 0 ? (histVal <= prevHist ? 20 : 10) : 0),
    bollinger: direction === 'long' ? (price < bbL + (bbU - bbL) * 0.15 ? 20 : price < bbM ? 10 : 0) : (price > bbU - (bbU - bbL) * 0.15 ? 20 : price > bbM ? 10 : 0),
    divergence: direction === 'long' ? ((ctx.rsiDiv === 'bull' || ctx.macdDiv === 'bull') ? 20 : 0) : ((ctx.rsiDiv === 'bear' || ctx.macdDiv === 'bear') ? 20 : 0),
    volume: vol > vAvg * 1.5 ? 15 : vol > vAvg ? 8 : 0,
    total,
    direction,
  };
}

// ==================== 4 路信号检测器（保留，用于信号历史） ====================

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

function detectBollingerWithVolume(
  klines: KlineData[],
  i: number,
  bb: { upper: number[]; middle: number[]; lower: number[] },
  volAvg: number[],
): RapidSignal | null {
  if (i < 1 || isNaN(bb.lower[i]) || isNaN(bb.upper[i])) return null;
  const close = klines[i].close;
  const prevClose = klines[i - 1].close;
  const vol = klines[i].volume;
  const vAvg = volAvg[i];
  const isHighVolume = !isNaN(vAvg) && vAvg > 0 && vol >= vAvg * RAPID_CONFIG.volumeBreakoutMult;

  if (close < bb.lower[i] && prevClose >= bb.lower[i - 1]) {
    return {
      id: `bollinger-long-${klines[i].time}`,
      source: 'bollinger',
      direction: 'long',
      entry: close,
      stop: 0, target: 0, atr: 0,
      confidence: isHighVolume ? 2 : 1,
      confluenceSources: ['bollinger'],
      time: klines[i].time,
      reason: isHighVolume
        ? '放量跌破布林带下轨（超卖回归）'
        : '缩量触及布林带下轨',
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
      confidence: isHighVolume ? 2 : 1,
      confluenceSources: ['bollinger'],
      time: klines[i].time,
      reason: isHighVolume
        ? '放量突破布林带上轨（超买回归）'
        : '缩量触及布林带上轨',
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
      reason: `RSI=${rsi[i].toFixed(1)} 进入超卖区`,
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
      reason: `RSI=${rsi[i].toFixed(1)} 进入超买区`,
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
      reason: 'MACD 柱状图从负转正',
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
      reason: 'MACD 柱状图从正转负',
      barIndex: i,
    };
  }
  return null;
}

function detectDivergenceSignal(
  klines: KlineData[],
  i: number,
  rsiDiv: 'bull' | 'bear' | 'none',
  macdDiv: 'bull' | 'bear' | 'none',
): RapidSignal | null {
  if (rsiDiv === 'bull' || macdDiv === 'bull') {
    const sources: string[] = [];
    if (rsiDiv === 'bull') sources.push('RSI底背离');
    if (macdDiv === 'bull') sources.push('MACD底背离');
    return {
      id: `divergence-long-${klines[i].time}`,
      source: 'divergence',
      direction: 'long',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 2,
      confluenceSources: ['divergence'],
      time: klines[i].time,
      reason: `看多背离：${sources.join(' + ')}`,
      barIndex: i,
    };
  }
  if (rsiDiv === 'bear' || macdDiv === 'bear') {
    const sources: string[] = [];
    if (rsiDiv === 'bear') sources.push('RSI顶背离');
    if (macdDiv === 'bear') sources.push('MACD顶背离');
    return {
      id: `divergence-short-${klines[i].time}`,
      source: 'divergence',
      direction: 'short',
      entry: klines[i].close,
      stop: 0, target: 0, atr: 0,
      confidence: 2,
      confluenceSources: ['divergence'],
      time: klines[i].time,
      reason: `看空背离：${sources.join(' + ')}`,
      barIndex: i,
    };
  }
  return null;
}

// ==================== v2 新增：冷却期检测 ====================

function isInCooldown(
  allSignals: RapidSignal[],
  currentBar: number,
  cooldownBars: number,
  direction: Direction,
): boolean {
  // 检查最近 cooldownBars 根K线内是否有同方向信号
  for (let i = allSignals.length - 1; i >= 0; i--) {
    const sig = allSignals[i];
    if (sig.barIndex < currentBar - cooldownBars) break;
    if (sig.barIndex >= currentBar - cooldownBars && sig.barIndex < currentBar && sig.direction === direction) {
      return true;
    }
  }
  return false;
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
  const ema50 = emaSeries(closes, RAPID_CONFIG.emaTrend);
  const bb = bollingerBands(klines, RAPID_CONFIG.bollingerPeriod, RAPID_CONFIG.bollingerStd);
  const rsi = rsiSeries(klines, RAPID_CONFIG.rsiPeriod);
  const macd = macdData(klines, RAPID_CONFIG.macdFast, RAPID_CONFIG.macdSlow, RAPID_CONFIG.macdSignal);
  const atr = atrSeries(klines, RAPID_CONFIG.atrPeriod);
  const volAvg = volumeAvgSeries(klines, RAPID_CONFIG.volumeAvgPeriod);

  const lookback = 20;
  const startIdx = Math.max(1, n - lookback);
  const allSignals: RapidSignal[] = [];

  // v3：先检测震荡区间，用于信号过滤
  const preATR = atr[n - 1];
  const preRangeInfo = detectRange(klines, preATR);
  const isRangeMode = preRangeInfo.isRange;

  for (let i = startIdx; i < n; i++) {
    // v2：背离检测（只检测当前根）
    const rsiDiv = i === n - 1 ? detectRSIDivergence(klines, rsi, RAPID_CONFIG.divergenceLookback, i) : 'none';
    const macdDiv = i === n - 1 ? detectMACDDivergence(klines, macd.hist, RAPID_CONFIG.divergenceLookback, i) : 'none';

    const detectors: (RapidSignal | null)[] = [
      detectEMACross(klines, i, ema9, ema21),
      detectBollingerWithVolume(klines, i, bb, volAvg),
      detectRSI(klines, i, rsi),
      detectMACDFlip(klines, i, macd.hist),
      detectDivergenceSignal(klines, i, rsiDiv, macdDiv),
    ];

    for (const sig of detectors) {
      if (!sig) continue;

      // v2 优化1：趋势过滤（EMA50）— 震荡模式跳过趋势过滤
      if (RAPID_CONFIG.useTrendFilter && !isRangeMode) {
        const isUptrend = klines[i].close > ema50[i];
        const isDowntrend = klines[i].close < ema50[i];
        if (sig.direction === 'long' && !isUptrend) continue;
        if (sig.direction === 'short' && !isDowntrend) continue;
      }

      allSignals.push(sig);
    }
  }

  const currentATR = atr[n - 1];
  const currentPrice = klines[n - 1].close;
  const latestBar = n - 1;
  const rangeInfo = preRangeInfo;

  for (const sig of allSignals) {
    sig.atr = currentATR;
    sig.stop = sig.direction === 'long'
      ? sig.entry - RAPID_CONFIG.stopATRMult * currentATR
      : sig.entry + RAPID_CONFIG.stopATRMult * currentATR;
    sig.target = sig.direction === 'long'
      ? sig.entry + RAPID_CONFIG.targetATRMult * currentATR
      : sig.entry - RAPID_CONFIG.targetATRMult * currentATR;
  }

  // v2：背离检测（用于评分和状态展示）
  const currentRsiDiv = detectRSIDivergence(klines, rsi, RAPID_CONFIG.divergenceLookback, latestBar);
  const currentMacdDiv = detectMACDDivergence(klines, macd.hist, RAPID_CONFIG.divergenceLookback, latestBar);

  // v2 优化4：信号评分
  const score = calcSignalScore(klines, latestBar, {
    ema50, ema9, ema21, bb, rsi, macd, atr, volAvg,
    rsiDiv: currentRsiDiv, macdDiv: currentMacdDiv,
  });

  // v2 优化5：冷却期检测
  const cooldownActive = isInCooldown(allSignals, latestBar, RAPID_CONFIG.cooldownBars, score.direction as Direction);

  const effectiveThreshold = isRangeMode ? RAPID_CONFIG.rangeScoreThreshold : RAPID_CONFIG.scoreThreshold;

  // 共振统计（用于显示）
  const recentWindow = allSignals.filter(s => s.barIndex >= latestBar - 1);
  const longSources = new Set<SignalSource>();
  const shortSources = new Set<SignalSource>();
  for (const s of recentWindow) {
    if (s.direction === 'long') longSources.add(s.source);
    else shortSources.add(s.source);
  }

  const merged = mergeConfluence(recentWindow, currentATR, currentPrice, latestBar, klines);

  // v2：suggestion 基于评分 + v3 震荡模式
  const winningSources = score.direction === 'long' ? Array.from(longSources) : Array.from(shortSources);

  let suggestion: RapidAnalysis['suggestion'];

  if (isRangeMode) {
    // ===== 震荡模式：支撑做多 / 阻力做空 =====
    const rangeStopMult = 0.5; // 止损在区间外0.5倍ATR
    if (rangeInfo.position === 'near-support' && score.direction !== 'short') {
      // 接近支撑 → 做多
      const entry = currentPrice;
      const stop = rangeInfo.support - currentATR * rangeStopMult;
      const target = rangeInfo.resistance;
      const rangeScore = Math.max(score.total, 50); // 震荡模式最低给50分
      suggestion = {
        direction: 'long',
        entry: round(entry, 2),
        stop: round(stop, 2),
        target: round(target, 2),
        confidence: Math.max(winningSources.length, 1),
        score: rangeScore,
        sources: winningSources.length > 0 ? winningSources : ['bollinger'],
        reason: `震荡区间：支撑${rangeInfo.support}做多，目标阻力${rangeInfo.resistance}（区间${rangeInfo.widthPct}%）`,
        mode: 'range',
      };
    } else if (rangeInfo.position === 'near-resistance' && score.direction !== 'long') {
      // 接近阻力 → 做空
      const entry = currentPrice;
      const stop = rangeInfo.resistance + currentATR * rangeStopMult;
      const target = rangeInfo.support;
      const rangeScore = Math.max(score.total, 50);
      suggestion = {
        direction: 'short',
        entry: round(entry, 2),
        stop: round(stop, 2),
        target: round(target, 2),
        confidence: Math.max(winningSources.length, 1),
        score: rangeScore,
        sources: winningSources.length > 0 ? winningSources : ['bollinger'],
        reason: `震荡区间：阻力${rangeInfo.resistance}做空，目标支撑${rangeInfo.support}（区间${rangeInfo.widthPct}%）`,
        mode: 'range',
      };
    } else {
      // 在区间中间，不开仓
      suggestion = {
        direction: 'none',
        entry: 0, stop: 0, target: 0, confidence: 0, score: score.total,
        sources: [],
        reason: `震荡区间${rangeInfo.support}~${rangeInfo.resistance}，当前在区间中部，等待接近边界`,
        mode: 'range',
      };
    }
  } else if (score.direction !== 'none' && score.total >= effectiveThreshold && !cooldownActive) {
    // ===== 趋势模式：评分达标 =====
    suggestion = {
      direction: score.direction as Direction,
      entry: currentPrice,
      stop: score.direction === 'long'
        ? currentPrice - RAPID_CONFIG.stopATRMult * currentATR
        : currentPrice + RAPID_CONFIG.stopATRMult * currentATR,
      target: score.direction === 'long'
        ? currentPrice + RAPID_CONFIG.confluenceTargetMult * currentATR
        : currentPrice - RAPID_CONFIG.confluenceTargetMult * currentATR,
      confidence: winningSources.length,
      score: score.total,
      sources: winningSources,
      reason: buildScoreReason(score.direction as Direction, score, winningSources),
      mode: 'trend',
    };
  } else {
    // 无信号
    suggestion = {
      direction: 'none' as const,
      entry: 0, stop: 0, target: 0, confidence: 0, score: score.total,
      sources: [],
      reason: score.total >= effectiveThreshold
        ? '信号方向冷却中，等待冷却结束' : `评分 ${score.total} 分，未达 ${effectiveThreshold} 分阈值`,
      mode: isRangeMode ? 'range' : 'trend',
    };
  }

  const indicatorState: IndicatorState = {
    ema9: round(ema9[n - 1], 2),
    ema21: round(ema21[n - 1], 2),
    ema50: round(ema50[n - 1], 2),
    emaCross: ema9[n - 1] > ema21[n - 1] ? 'up' : ema9[n - 1] < ema21[n - 1] ? 'down' : 'none',
    trend: currentPrice > ema50[n - 1] ? 'up' : currentPrice < ema50[n - 1] ? 'down' : 'neutral',
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
    volumeAvg: round(volAvg[n - 1] || 0, 2),
    currentVolume: klines[n - 1].volume,
    rsiDivergence: currentRsiDiv,
    macdDivergence: currentMacdDiv,
  };

  return {
    symbol,
    currentPrice,
    timestamp: now,
    signals: merged,
    confluence: { long: longSources.size, short: shortSources.size },
    indicatorState,
    score,
    rangeInfo,
    suggestion,
    recentSignals: allSignals.slice(-10),
  };
}

// ==================== 辅助函数 ====================

function mergeConfluence(
  recentWindow: RapidSignal[],
  atr: number,
  price: number,
  barIndex: number,
  klines: KlineData[],
): RapidSignal[] {
  const longSources = new Set<SignalSource>();
  const shortSources = new Set<SignalSource>();
  for (const s of recentWindow) {
    if (s.direction === 'long') longSources.add(s.source);
    else shortSources.add(s.source);
  }

  const result: RapidSignal[] = [];
  if (longSources.size > 0) {
    result.push(createMergedSignal('long', Array.from(longSources), price, atr, barIndex, klines));
  }
  if (shortSources.size > 0) {
    result.push(createMergedSignal('short', Array.from(shortSources), price, atr, barIndex, klines));
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
  const targetMult = confidence >= 2 ? RAPID_CONFIG.confluenceTargetMult : RAPID_CONFIG.targetATRMult;

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
    'divergence': '背离',
  };
  const sourceText = sources.map(s => sourceNames[s]).join(' + ');
  const confluenceText = sources.length >= 2 ? `${sources.length}路共振` : '单信号';
  return `${dirText} · ${confluenceText} · ${sourceText}`;
}

function buildScoreReason(dir: Direction, score: ScoreBreakdown, sources: SignalSource[]): string {
  const dirText = dir === 'long' ? '做多' : '做空';
  const parts: string[] = [];
  if (score.trend >= 25) parts.push(`趋势顺势(${score.trend}分)`);
  if (score.momentum >= 20) parts.push(`动量强劲(${score.momentum}分)`);
  else if (score.momentum >= 10) parts.push(`动量减弱(${score.momentum}分)`);
  if (score.bollinger >= 20) parts.push(`布林极值(${score.bollinger}分)`);
  else if (score.bollinger >= 10) parts.push(`布林偏移(${score.bollinger}分)`);
  if (score.divergence >= 20) parts.push(`背离信号(${score.divergence}分)`);
  if (score.volume >= 15) parts.push(`放量确认(${score.volume}分)`);
  else if (score.volume >= 8) parts.push(`正常量能(${score.volume}分)`);
  const sourceText = sources.length > 0 ? ` · ${sources.length}路共振` : '';
  return `${dirText} · 总分${score.total} · ${parts.join(' + ')}${sourceText}`;
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
      ema9: 0, ema21: 0, ema50: 0, emaCross: 'none', trend: 'neutral',
      bollingerUpper: 0, bollingerMiddle: 0, bollingerLower: 0, bollingerPosition: 'middle',
      rsi: 50, rsiState: 'neutral',
      macdHist: 0, macdHistTrend: 'flat',
      atr: 0, price,
      volumeAvg: 0, currentVolume: 0,
      rsiDivergence: 'none', macdDivergence: 'none',
    },
    score: { trend: 0, momentum: 0, bollinger: 0, divergence: 0, volume: 0, total: 0, direction: 'none' },
    rangeInfo: { isRange: false, support: 0, resistance: 0, width: 0, widthPct: 0, position: 'middle', touches: 0, lookbackBars: 0 },
    suggestion: { direction: 'none', entry: 0, stop: 0, target: 0, confidence: 0, score: 0, sources: [], reason: 'K 线数据不足', mode: 'trend' },
    recentSignals: [],
  };
}

function round(n: number, decimals: number): number {
  const m = 10 ** decimals;
  return Math.round(n * m) / m;
}
