// 技术指标计算 - 移植自 v5.4 版本
// 布林带 / MACD / EMA / RSI

import { KlineData } from './market-data';

// EMA（指数移动平均）
// 标准 EMA：前 period 个值用 SMA 作为初始种子值，后续用递推公式
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  // 前 period-1 个位置用 SMA 填充（不足 period 时用已有数据的均值）
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      // 数据不足 period 个时，用已有数据的均值作为当前值
      out.push(values.slice(0, i + 1).reduce((s, v) => s + v, 0) / (i + 1));
    } else if (i === period - 1) {
      // 第 period 个值用 SMA 初始化
      const sma = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
      out.push(sma);
    } else {
      // 后续用标准 EMA 递推公式
      out.push(values[i] * k + out[i - 1] * (1 - k));
    }
  }
  return out;
}

// EMA 数组
export function calcEMAArray(klines: KlineData[], period: number): number[] {
  const closes = klines.map((k) => k.close);
  return ema(closes, period);
}

// 布林带
export interface BollingerData {
  upper: number;
  middle: number;
  lower: number;
  upperSeries: { time: number; value: number }[];
  middleSeries: { time: number; value: number }[];
  lowerSeries: { time: number; value: number }[];
}

export function calcBollinger(klines: KlineData[], period: number = 20): BollingerData | null {
  if (!klines || klines.length < period) return null;
  const upper: { time: number; value: number }[] = [];
  const middle: { time: number; value: number }[] = [];
  const lower: { time: number; value: number }[] = [];

  for (let i = period - 1; i < klines.length; i++) {
    const recent = klines.slice(i - (period - 1), i + 1);
    const mid = recent.reduce((s, k) => s + k.close, 0) / recent.length;
    const variance =
      recent.reduce((s, k) => s + Math.pow(k.close - mid, 2), 0) / recent.length;
    const sd = Math.sqrt(variance);
    upper.push({ time: klines[i].time, value: mid + 2 * sd });
    middle.push({ time: klines[i].time, value: mid });
    lower.push({ time: klines[i].time, value: mid - 2 * sd });
  }

  const last = upper.length - 1;
  return {
    upper: upper[last]?.value || 0,
    middle: middle[last]?.value || 0,
    lower: lower[last]?.value || 0,
    upperSeries: upper,
    middleSeries: middle,
    lowerSeries: lower,
  };
}

// MACD
export interface MACDData {
  dif: (number | null)[];
  dea: (number | null)[];
  hist: (number | null)[];
  lastDif: number;
  lastDea: number;
  lastHist: number;
}

export function calcMACD(klines: KlineData[], fastP: number = 12, slowP: number = 26, signalP: number = 9): MACDData | null {
  if (!klines || klines.length < slowP + signalP) return null;
  const closes = klines.map((k) => k.close);
  const fast = ema(closes, fastP);
  const slow = ema(closes, slowP);
  const dif: number[] = [];
  for (let i = 0; i < closes.length; i++) dif.push(fast[i] - slow[i]);

  const deaRaw = ema(dif.slice(slowP - 1), signalP);
  const dea: (number | null)[] = [];
  const hist: (number | null)[] = [];
  for (let j = 0; j < slowP - 1; j++) { dea.push(null); hist.push(null); }
  for (let x = 0; x < deaRaw.length; x++) {
    dea.push(deaRaw[x]);
    hist.push((dif[slowP - 1 + x] - deaRaw[x]) * 2);
  }

  const last = closes.length - 1;
  return {
    dif,
    dea,
    hist,
    lastDif: dif[last],
    lastDea: dea[last] || 0,
    lastHist: hist[last] || 0,
  };
}

// RSI 数组（用于图表绘制）
export function calcRSIArray(klines: KlineData[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [];
  if (!klines || klines.length < period + 1) return result;
  // 前 period 个值为 null
  for (let i = 0; i < period; i++) result.push(null);
  // 使用 Wilder's smoothing 计算 RSI
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < klines.length; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) { result.push(100); continue; }
    const rs = avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

// ==================== 趋势通道（Trend Channel） ====================

export interface TrendChannel {
  direction: 'up' | 'down' | 'neutral';
  // 上轨：两个高点连线
  upperStart: { time: number; price: number };
  upperEnd: { time: number; price: number };
  // 下轨：两个低点连线
  lowerStart: { time: number; price: number };
  lowerEnd: { time: number; price: number };
  // 中轨
  midStart: { time: number; price: number };
  midEnd: { time: number; price: number };
  // 触及次数
  upperTouches: number;
  lowerTouches: number;
  // 通道宽度百分比
  widthPct: number;
  // 回归斜率（每根K线变化量）
  slope: number;
}

/**
 * 自动识别趋势通道
 * 算法：
 * 1. 在最近N根K线内找到两个显著高点和两个显著低点
 * 2. 用线性回归拟合趋势方向
 * 3. 上下轨平行于回归线，距离为极值偏差
 */
export function calcTrendChannel(klines: KlineData[], lookback: number = 60): TrendChannel | null {
  const n = klines.length;
  if (n < 20) return null;

  const window = klines.slice(Math.max(0, n - lookback));
  const w = window.length;
  if (w < 15) return null;

  // 线性回归：用收盘价拟合趋势线
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < w; i++) {
    sumX += i;
    sumY += window[i].close;
    sumXY += i * window[i].close;
    sumX2 += i * i;
  }
  const meanX = sumX / w;
  const meanY = sumY / w;
  const slope = (sumXY - w * meanX * meanY) / (sumX2 - w * meanX * meanX);
  const intercept = meanY - slope * meanX;

  // 计算每个点到回归线的偏差
  let maxDevUp = 0, maxDevDown = 0;
  let upperTouches = 0, lowerTouches = 0;
  for (let i = 0; i < w; i++) {
    const trendPrice = intercept + slope * i;
    const devHigh = window[i].high - trendPrice;
    const devLow = window[i].low - trendPrice;
    if (devHigh > maxDevUp) maxDevUp = devHigh;
    if (devLow < maxDevDown) maxDevDown = devLow;
  }

  // 用更稳健的方式：取最高的3个高点均值 和 最低的3个低点均值 作为轨道
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < w; i++) {
    highs.push(window[i].high);
    lows.push(window[i].low);
  }
  highs.sort((a, b) => b - a);
  lows.sort((a, b) => a - b);

  const avgHigh = highs.slice(0, Math.min(3, Math.floor(w / 5))).reduce((s, v) => s + v, 0) / Math.min(3, Math.floor(w / 5));
  const avgLow = lows.slice(0, Math.min(3, Math.floor(w / 5))).reduce((s, v) => s + v, 0) / Math.min(3, Math.floor(w / 5));

  const upperOffset = avgHigh - (intercept + slope * (w / 2));
  const lowerOffset = avgLow - (intercept + slope * (w / 2));

  // 实际的上下轨：平行于回归线
  const upperIntercept = intercept + upperOffset;
  const lowerIntercept = intercept + lowerOffset;

  // 统计触及次数（接近轨道的K线数）
  const tolerance = Math.abs(maxDevUp - maxDevDown) * 0.15;
  for (let i = 0; i < w; i++) {
    const upperPrice = upperIntercept + slope * i;
    const lowerPrice = lowerIntercept + slope * i;
    if (Math.abs(window[i].high - upperPrice) < tolerance) upperTouches++;
    if (Math.abs(window[i].low - lowerPrice) < tolerance) lowerTouches++;
  }

  const startIdx = Math.max(0, n - lookback);
  const endIdx = n - 1;
  const startTime = window[0].time;
  const endTime = window[w - 1].time;

  // 延伸到未来5根K线的位置（用于预测）
  const extendBars = 5;
  const endX = w - 1 + extendBars;
  const endTimeExtended = window[w - 1].time + (window[w - 1].time - window[w - 2].time) * extendBars;

  const midPriceStart = intercept;
  const midPriceEnd = intercept + slope * endX;
  const upperPriceStart = upperIntercept;
  const upperPriceEnd = upperIntercept + slope * endX;
  const lowerPriceStart = lowerIntercept;
  const lowerPriceEnd = lowerIntercept + slope * endX;

  const widthPct = midPriceStart > 0 ? ((upperPriceStart - lowerPriceStart) / midPriceStart) * 100 : 0;
  const direction = slope > 0.001 ? 'up' : slope < -0.001 ? 'down' : 'neutral';

  return {
    direction,
    upperStart: { time: startTime, price: upperPriceStart },
    upperEnd: { time: endTimeExtended, price: upperPriceEnd },
    lowerStart: { time: startTime, price: lowerPriceStart },
    lowerEnd: { time: endTimeExtended, price: lowerPriceEnd },
    midStart: { time: startTime, price: midPriceStart },
    midEnd: { time: endTimeExtended, price: midPriceEnd },
    upperTouches,
    lowerTouches,
    widthPct: Math.round(widthPct * 100) / 100,
    slope,
  };
}

// ==================== 安德鲁音叉（Andrew's Pitchfork） ====================

export interface Pitchfork {
  direction: 'up' | 'down';
  // 三个基准点（A=起点, B=第一腿终点, C=回调终点）
  pointA: { time: number; price: number };
  pointB: { time: number; price: number };
  pointC: { time: number; price: number };
  // 中轨（median line）：从A出发，穿过B-C中点
  medianStart: { time: number; price: number };
  medianEnd: { time: number; price: number };
  // 上轨（upper MLH）：从B出发，平行于中轨
  upperStart: { time: number; price: number };
  upperEnd: { time: number; price: number };
  // 下轨（lower MLH）：从C出发，平行于中轨
  lowerStart: { time: number; price: number };
  lowerEnd: { time: number; price: number };
  // 警告线（上下各一条，距离中轨2倍间距）
  upperWarningStart: { time: number; price: number };
  upperWarningEnd: { time: number; price: number };
  lowerWarningStart: { time: number; price: number };
  lowerWarningEnd: { time: number; price: number };
  // 价格在音叉中的位置
  pricePosition: 'above-upper' | 'between-upper-median' | 'between-median-lower' | 'below-lower';
}

/**
 * 自动识别安德鲁音叉
 * 算法：
 * 1. 找最近一段显著趋势（A到B）
 * 2. 找B之后的回调点C
 * 3. 从A出发，穿过B-C中点画中轨
 * 4. 从B和C分别画平行线作为上下轨
 */
export function calcPitchfork(klines: KlineData[], lookback: number = 80): Pitchfork | null {
  const n = klines.length;
  if (n < 30) return null;

  const startIdx = Math.max(0, n - lookback);
  const window = klines.slice(startIdx);
  const w = window.length;
  if (w < 25) return null;

  // 摆动点检测（分形：不低于/不高于前后各2根）
  const isSwingHigh = (i: number): boolean => {
    if (i < 2 || i > w - 3) return false;
    return window[i].high >= window[i-1].high && window[i].high >= window[i-2].high
        && window[i].high >= window[i+1].high && window[i].high >= window[i+2].high;
  };
  const isSwingLow = (i: number): boolean => {
    if (i < 2 || i > w - 3) return false;
    return window[i].low <= window[i-1].low && window[i].low <= window[i-2].low
        && window[i].low <= window[i+1].low && window[i].low <= window[i+2].low;
  };

  // 窗口总波幅（用于显著性过滤）
  let wHigh = -Infinity, wLow = Infinity;
  for (const k of window) {
    if (k.high > wHigh) wHigh = k.high;
    if (k.low < wLow) wLow = k.low;
  }
  const totalRange = wHigh - wLow;
  if (totalRange <= 0) return null;

  // 上升音叉：A=B之前的最低点（趋势起点），B=摆动高点，C=B之后的回调低点
  const tryUpward = (minABPct: number): { a: number; b: number; c: number } | null => {
    const minAB = totalRange * minABPct;
    for (let b = w - 3; b >= 3; b--) {
      if (!isSwingHigh(b)) continue;
      // C = B 之后的最低 low
      let cIdx = -1, cLow = Infinity;
      for (let i = b + 1; i < w; i++) {
        if (window[i].low < cLow) { cLow = window[i].low; cIdx = i; }
      }
      if (cIdx < 0) continue;
      // A = B 之前的最低 low
      let aIdx = -1, aLow = Infinity;
      for (let i = 0; i < b; i++) {
        if (window[i].low < aLow) { aLow = window[i].low; aIdx = i; }
      }
      if (aIdx < 0) continue;
      const abRange = window[b].high - aLow;
      if (abRange < minAB) continue;
      const cbRetrace = window[b].high - cLow;
      if (cbRetrace < abRange * 0.15) continue;
      return { a: aIdx, b, c: cIdx };
    }
    return null;
  };

  // 下降音叉：A=B之前的最高点，B=摆动低点，C=B之后的反弹高点
  const tryDownward = (minABPct: number): { a: number; b: number; c: number } | null => {
    const minAB = totalRange * minABPct;
    for (let b = w - 3; b >= 3; b--) {
      if (!isSwingLow(b)) continue;
      // C = B 之后的最高 high
      let cIdx = -1, cHigh = -Infinity;
      for (let i = b + 1; i < w; i++) {
        if (window[i].high > cHigh) { cHigh = window[i].high; cIdx = i; }
      }
      if (cIdx < 0) continue;
      // A = B 之前的最高 high
      let aIdx = -1, aHigh = -Infinity;
      for (let i = 0; i < b; i++) {
        if (window[i].high > aHigh) { aHigh = window[i].high; aIdx = i; }
      }
      if (aIdx < 0) continue;
      const abRange = aHigh - window[b].low;
      if (abRange < minAB) continue;
      const cbRetrace = cHigh - window[b].low;
      if (cbRetrace < abRange * 0.15) continue;
      return { a: aIdx, b, c: cIdx };
    }
    return null;
  };

  // 第一轮要求 AB 段占窗口波幅 35% 以上（显著趋势）；
  // 第二轮放宽到 12% —— 强单边行情里最近的回调都很浅，完全过滤会导致音叉经常消失
  const upStruct = tryUpward(0.35) ?? tryUpward(0.12);
  const downStruct = tryDownward(0.35) ?? tryDownward(0.12);

  // 两个方向都有结构时取更近的（b 更大）那个，保证音叉锚定最新行情
  let built: { a: number; b: number; c: number; dir: 'up' | 'down' } | null = null;
  if (upStruct && downStruct) {
    built = upStruct.b >= downStruct.b ? { ...upStruct, dir: 'up' as const } : { ...downStruct, dir: 'down' as const };
  } else if (upStruct) {
    built = { ...upStruct, dir: 'up' as const };
  } else if (downStruct) {
    built = { ...downStruct, dir: 'down' as const };
  }
  if (!built) return null;

  const isUpward = built.dir === 'up';
  const direction: 'up' | 'down' = built.dir;
  const pointA_idx = built.a;
  const pointB_idx = built.b;
  const pointC_idx = built.c;

  // 三个基准点
  const pointA = { time: window[pointA_idx].time, price: isUpward ? window[pointA_idx].low : window[pointA_idx].high };
  const pointB = { time: window[pointB_idx].time, price: isUpward ? window[pointB_idx].high : window[pointB_idx].low };
  const pointC = { time: window[pointC_idx].time, price: isUpward ? window[pointC_idx].low : window[pointC_idx].high };

  // B-C中点
  const midBC = {
    time: (pointB.time + pointC.time) / 2,
    price: (pointB.price + pointC.price) / 2,
  };

  // 中轨：从A出发，穿过B-C中点，延伸到未来
  // 计算斜率（每单位时间的价格变化）
  const timeSpan = midBC.time - pointA.time;
  if (timeSpan <= 0) return null;
  const medianSlope = (midBC.price - pointA.price) / timeSpan;

  // 延伸到未来：窗口末端 + 音叉总长度的0.5倍
  const totalTimeSpan = pointC.time - pointA.time;
  const extendTime = totalTimeSpan * 0.5;
  const endTime = window[w - 1].time + extendTime;

  // 中轨起止点
  const medianStart = { time: pointA.time, price: pointA.price };
  const medianEnd = { time: endTime, price: pointA.price + medianSlope * (endTime - pointA.time) };

  // 上轨：从B出发，平行于中轨
  const upperStart = { time: pointB.time, price: pointB.price };
  const upperEnd = { time: endTime, price: pointB.price + medianSlope * (endTime - pointB.time) };

  // 下轨：从C出发，平行于中轨
  const lowerStart = { time: pointC.time, price: pointC.price };
  const lowerEnd = { time: endTime, price: pointC.price + medianSlope * (endTime - pointC.time) };

  // 警告线：距离中轨2倍间距（在中轨另一侧再加一倍）
  // 上警告线 = 上轨 + (上轨-中轨) = 2*上轨 - 中轨
  const upperWarningStart = { time: pointB.time, price: pointB.price + (pointB.price - midBC.price) };
  const upperWarningEnd = { time: endTime, price: upperWarningStart.price + medianSlope * (endTime - pointB.time) };

  const lowerWarningStart = { time: pointC.time, price: pointC.price - (midBC.price - pointC.price) };
  const lowerWarningEnd = { time: endTime, price: lowerWarningStart.price + medianSlope * (endTime - pointC.time) };

  // 当前价格位置
  const currentPrice = window[w - 1].close;
  const currentTime = window[w - 1].time;
  const medianAtCurrent = pointA.price + medianSlope * (currentTime - pointA.time);
  const upperAtCurrent = pointB.price + medianSlope * (currentTime - pointB.time);
  const lowerAtCurrent = pointC.price + medianSlope * (currentTime - pointC.time);

  let pricePosition: Pitchfork['pricePosition'];
  if (currentPrice > upperAtCurrent) pricePosition = 'above-upper';
  else if (currentPrice > medianAtCurrent) pricePosition = 'between-upper-median';
  else if (currentPrice > lowerAtCurrent) pricePosition = 'between-median-lower';
  else pricePosition = 'below-lower';

  return {
    direction,
    pointA,
    pointB,
    pointC,
    medianStart,
    medianEnd,
    upperStart,
    upperEnd,
    lowerStart,
    lowerEnd,
    upperWarningStart,
    upperWarningEnd,
    lowerWarningStart,
    lowerWarningEnd,
    pricePosition,
  };
}

// ========== 缠论（Chanlun）K线合并→分型→笔→中枢→买卖点 ==========

export interface ChanFractal {
  index: number;
  time: number;
  price: number;
  type: 'top' | 'bottom';
}

export interface ChanBi {
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  startPrice: number;
  endPrice: number;
  direction: 'up' | 'down';
}

export interface ChanZhongshu {
  startTime: number;
  endTime: number;
  high: number;
  low: number;
  biCount: number;
  level: number;        // 级别：1=本级别，2=高一级别（延伸9笔升级）
  isExtended: boolean;  // 是否延伸（超过6笔未突破）
}

export interface ChanSignal {
  type: 'firstBuy' | 'firstSell' | 'secondBuy' | 'secondSell' | 'thirdBuy' | 'thirdSell';
  price: number;
  time: number;
  description: string;
}

// ===== 预警投射：提前预测画线 =====
// 中枢突破投射线、潜在买卖点预标、未完成笔预警、笔延长投射
export interface ChanProjection {
  type:
    | 'zsBreakoutUp'    // 中枢上沿突破投射线
    | 'zsBreakoutDown'  // 中枢下沿突破投射线
    | 'potentialBuy'    // 潜在买点预标
    | 'potentialSell'   // 潜在卖点预标
    | 'biExtension'     // 笔延长投射（虚线）
    | 'pendingFractal'; // 未完成分型预警
  price: number;
  time: number;         // 起始时间
  endTime: number;      // 投射线结束时间（延伸到屏幕右侧）
  label: string;
  description: string;
  isNear: boolean;      // 价格是否接近该投射位
}

export interface ChanResult {
  fractals: ChanFractal[];
  bis: ChanBi[];
  zhongshus: ChanZhongshu[];
  signals: ChanSignal[];
  projections: ChanProjection[];
}

// ===== 第一步：K线包含关系处理（合并） =====
// 标准缠论要求先合并包含关系的K线，再识别分型。
// 规则：相邻两根K线，如果一根完全包含另一根（高低点都在范围内），则合并。
// 合并方向取决于趋势方向：
//   向上趋势中：取较高的高点和较高的低点
//   向下趋势中：取较低的高点和较低的低点
interface MergedKline {
  index: number;   // 原始K线索引
  time: number;
  high: number;
  low: number;
  open: number;
  close: number;
  volume: number;
  direction: 'up' | 'down';
}

function mergeKlines(klines: KlineData[]): MergedKline[] {
  if (klines.length === 0) return [];
  const merged: MergedKline[] = [{
    index: 0, time: klines[0].time, high: klines[0].high, low: klines[0].low,
    open: klines[0].open, close: klines[0].close, volume: klines[0].volume,
    direction: klines[0].close >= klines[0].open ? 'up' : 'down',
  }];
  for (let i = 1; i < klines.length; i++) {
    const curr = klines[i];
    const last = merged[merged.length - 1];
    // 包含关系：一方的高低点完全包含另一方
    const hasInclusion =
      (last.high >= curr.high && last.low <= curr.low) ||
      (curr.high >= last.high && curr.low <= last.low);
    if (hasInclusion) {
      // 按趋势方向合并
      if (last.direction === 'up') {
        last.high = Math.max(last.high, curr.high);
        last.low = Math.max(last.low, curr.low);
      } else {
        last.high = Math.min(last.high, curr.high);
        last.low = Math.min(last.low, curr.low);
      }
      last.volume += curr.volume;
    } else {
      // 无包含，新增，方向由高低点关系确定
      const newDir: 'up' | 'down' =
        curr.high > last.high ? 'up' : curr.low < last.low ? 'down' : last.direction;
      merged.push({
        index: i, time: curr.time, high: curr.high, low: curr.low,
        open: curr.open, close: curr.close, volume: curr.volume, direction: newDir,
      });
    }
  }
  return merged;
}

// ===== 第二步：分型识别（在合并后的K线上） =====
function detectChanFractals(merged: MergedKline[]): ChanFractal[] {
  const fractals: ChanFractal[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const prev = merged[i - 1];
    const curr = merged[i];
    const next = merged[i + 1];
    // 顶分型：高点最高 + 低点也最高
    if (curr.high > prev.high && curr.high > next.high &&
        curr.low > prev.low && curr.low > next.low) {
      fractals.push({ index: curr.index, time: curr.time, price: curr.high, type: 'top' });
    }
    // 底分型：低点最低 + 高点也最低
    if (curr.low < prev.low && curr.low < next.low &&
        curr.high < prev.high && curr.high < next.high) {
      fractals.push({ index: curr.index, time: curr.time, price: curr.low, type: 'bottom' });
    }
  }
  return fractals;
}

// 笔：连接相邻的顶底分型，要求至少间隔4根K线，中间不能有同向更优分型
function buildBi(fractals: ChanFractal[], klines: KlineData[]): ChanBi[] {
  const bis: ChanBi[] = [];
  if (fractals.length < 2) return bis;

  let i = 0;
  while (i < fractals.length - 1) {
    const start = fractals[i];
    // 找下一个相反类型的分型
    let endIdx = -1;
    for (let j = i + 1; j < fractals.length; j++) {
      const candidate = fractals[j];
      // 必须是相反类型
      if (candidate.type === start.type) continue;
      // 间隔至少4根K线
      if (candidate.index - start.index < 4) continue;
      // 对于顶→底（下降笔）：中间不能有比start更高的顶分型
      // 对于底→顶（上升笔）：中间不能有比start更低的底分型
      let valid = true;
      for (let k = i + 1; k < j; k++) {
        const mid = fractals[k];
        if (mid.type === start.type) {
          if (start.type === 'top' && mid.price > start.price) { valid = false; break; }
          if (start.type === 'bottom' && mid.price < start.price) { valid = false; break; }
        }
      }
      if (valid) {
        endIdx = j;
        break; // 找到第一个满足条件的就停止
      }
    }
    if (endIdx === -1) { i++; continue; }
    const end = fractals[endIdx];
    bis.push({
      startIndex: start.index,
      endIndex: end.index,
      startTime: start.time,
      endTime: end.time,
      startPrice: start.price,
      endPrice: end.price,
      direction: start.type === 'bottom' ? 'up' : 'down',
    });
    i = endIdx; // 从当前终点继续找下一笔
  }
  return bis;
}

// ===== 第四步：中枢构建（3笔重叠区间）+ 级别追踪 =====
// 中枢 = 至少3笔的价格重叠区间
// 延伸：中枢内超过6笔仍未突破 → 标记为延伸
// 升级：中枢内超过9笔 → 级别升级（level+1）
function buildZhongshu(bis: ChanBi[]): ChanZhongshu[] {
  const zhongshus: ChanZhongshu[] = [];
  if (bis.length < 3) return zhongshus;

  for (let i = 0; i <= bis.length - 3; i++) {
    const b1 = bis[i], b2 = bis[i + 1], b3 = bis[i + 2];
    const r1Low = Math.min(b1.startPrice, b1.endPrice);
    const r1High = Math.max(b1.startPrice, b1.endPrice);
    const r2Low = Math.min(b2.startPrice, b2.endPrice);
    const r2High = Math.max(b2.startPrice, b2.endPrice);
    const r3Low = Math.min(b3.startPrice, b3.endPrice);
    const r3High = Math.max(b3.startPrice, b3.endPrice);
    const overlapLow = Math.max(r1Low, r2Low, r3Low);
    const overlapHigh = Math.min(r1High, r2High, r3High);
    if (overlapLow < overlapHigh) {
      const last = zhongshus[zhongshus.length - 1];
      if (last && b1.startTime <= last.endTime) {
        // 延伸已有中枢前，检查新边界是否仍然有效
        const newHigh = Math.min(last.high, overlapHigh);
        const newLow = Math.max(last.low, overlapLow);
        if (newHigh > newLow) {
          // 边界仍然有效，延伸中枢
          last.endTime = b3.endTime;
          last.high = newHigh;
          last.low = newLow;
          last.biCount += 1;
          // 延伸判断：超过6笔标记延伸
          last.isExtended = last.biCount >= 6;
          // 升级判断：超过9笔级别+1
          if (last.biCount >= 9) last.level = 2;
        } else {
          // 边界交叉，中枢被破坏，创建新中枢
          zhongshus.push({
            startTime: b1.startTime,
            endTime: b3.endTime,
            high: overlapHigh,
            low: overlapLow,
            biCount: 3,
            level: 1,
            isExtended: false,
          });
        }
      } else {
        zhongshus.push({
          startTime: b1.startTime,
          endTime: b3.endTime,
          high: overlapHigh,
          low: overlapLow,
          biCount: 3,
          level: 1,
          isExtended: false,
        });
      }
    }
  }
  return zhongshus;
}

// ===== 第五步：三类买卖点检测 =====
// 一买/一卖：趋势背驰后的反转点（中枢外的力度衰减）
// 二买/二卖：反转后的第一次回抽不破中枢
// 三买/三卖：突破中枢后回踩不破中枢边界
function detectChanSignals(
  bis: ChanBi[],
  zhongshus: ChanZhongshu[],
  klines: KlineData[],
): ChanSignal[] {
  const signals: ChanSignal[] = [];
  if (zhongshus.length === 0 || bis.length === 0 || klines.length === 0) return signals;

  // 遍历每个中枢，检测各自的买卖点
  for (let zi = 0; zi < zhongshus.length; zi++) {
    const zs = zhongshus[zi];
    const isLast = zi === zhongshus.length - 1;

    // 找该中枢之后的笔
    const bisAfterZs = bis.filter(b => b.endTime >= zs.startTime && b.startTime <= (isLast ? Infinity : zhongshus[zi + 1].startTime));
    if (bisAfterZs.length === 0) continue;

    // 对每个中枢，检查其后的笔是否形成买卖点
    for (let bi = 0; bi < bisAfterZs.length; bi++) {
      const cb = bisAfterZs[bi];
      const lastPrice = cb.endPrice;
      const lastTime = cb.endTime;
      const lastBiLow = Math.min(cb.startPrice, cb.endPrice);
      const lastBiHigh = Math.max(cb.startPrice, cb.endPrice);

      // 三买：中枢之后某笔的最低点在中枢上沿之上
      if (lastBiLow > zs.high) {
        signals.push({
          type: 'thirdBuy', price: lastPrice, time: lastTime,
          description: `三买：${zi + 1}#中枢后回踩不破上沿`,
        });
        break; // 每个中枢只标第一个三买
      }
      // 三卖：中枢之后某笔的最高点在中枢下沿之下
      if (lastBiHigh < zs.low) {
        signals.push({
          type: 'thirdSell', price: lastPrice, time: lastTime,
          description: `三卖：${zi + 1}#中枢后反弹不破下沿`,
        });
        break;
      }
    }

    // 对最后一个中枢，额外检测当前价格的买卖点
    if (isLast) {
      const lastPrice = klines[klines.length - 1].close;
      const lastTime = klines[klines.length - 1].time;
      const bisForLast = bis.filter(b => b.endTime >= zs.startTime);
      if (bisForLast.length === 0) continue;
      const lastBi = bisForLast[bisForLast.length - 1];
      const lastBiLow = Math.min(lastBi.startPrice, lastBi.endPrice);
      const lastBiHigh = Math.max(lastBi.startPrice, lastBi.endPrice);

      // 一买：中枢下方，最后一笔下降背驰
      if (lastPrice < zs.low) {
        const downBis = bisForLast.filter(b => b.direction === 'down');
        if (downBis.length >= 2) {
          const lastDown = downBis[downBis.length - 1];
          const prevDown = downBis[downBis.length - 2];
          const lastRange = Math.abs(lastDown.endPrice - lastDown.startPrice);
          const prevRange = Math.abs(prevDown.endPrice - prevDown.startPrice);
          if (lastRange < prevRange * 0.8) {
            signals.push({
              type: 'firstBuy', price: lastPrice, time: lastTime,
              description: '一买：中枢下方下降笔背驰',
            });
          }
        }
      }
      // 一卖：中枢上方，最后一笔上升背驰
      if (lastPrice > zs.high) {
        const upBis = bisForLast.filter(b => b.direction === 'up');
        if (upBis.length >= 2) {
          const lastUp = upBis[upBis.length - 1];
          const prevUp = upBis[upBis.length - 2];
          const lastRange = Math.abs(lastUp.endPrice - lastUp.startPrice);
          const prevRange = Math.abs(prevUp.endPrice - prevUp.startPrice);
          if (lastRange < prevRange * 0.8) {
            signals.push({
              type: 'firstSell', price: lastPrice, time: lastTime,
              description: '一卖：中枢上方上升笔背驰',
            });
          }
        }
      }
      // 二买：中枢内偏上，回踩未破下沿
      if (lastPrice > zs.low && lastPrice < zs.high && lastBi.direction === 'down') {
        if (lastBi.endPrice > zs.low) {
          signals.push({
            type: 'secondBuy', price: lastPrice, time: lastTime,
            description: '二买：中枢内回踩未破下沿',
          });
        }
      }
      // 二卖：中枢内偏下，反弹未破上沿
      if (lastPrice > zs.low && lastPrice < zs.high && lastBi.direction === 'up') {
        if (lastBi.endPrice < zs.high) {
          signals.push({
            type: 'secondSell', price: lastPrice, time: lastTime,
            description: '二卖：中枢内反弹未破上沿',
          });
        }
      }
    }
  }

  return signals;
}

// ===== 第六步：预警投射（提前预测画线） =====
// 1. 中枢突破投射线：从最近中枢的上下沿画水平延伸线
// 2. 潜在买卖点预标：价格接近中枢边界时预标注
// 3. 未完成笔预警：当前K线若收在某价位将形成新分型
// 4. 笔延长投射：当前未完成笔按方向延伸虚线
function calcChanProjections(
  bis: ChanBi[],
  zhongshus: ChanZhongshu[],
  klines: KlineData[],
): ChanProjection[] {
  const projections: ChanProjection[] = [];
  if (klines.length === 0) return projections;

  const lastKline = klines[klines.length - 1];
  const lastPrice = lastKline.close;
  const lastTime = lastKline.time;
  // 投射线延伸到屏幕右侧：用最后一根K线时间 + 额外的K线周期
  const interval = klines.length > 1 ? klines[klines.length - 1].time - klines[klines.length - 2].time : 3600000;
  const projectionEndTime = lastTime + interval * 20; // 向右延伸20根K线

  // ===== 1. 中枢突破投射线 =====
  if (zhongshus.length > 0) {
    const lastZs = zhongshus[zhongshus.length - 1];

    // 上沿突破投射线
    const distUp = Math.abs(lastPrice - lastZs.high);
    const threshold = (lastZs.high - lastZs.low) * 0.15; // 15%中枢高度作为"接近"阈值
    const isNearUp = distUp < threshold;
    projections.push({
      type: 'zsBreakoutUp',
      price: lastZs.high,
      time: lastZs.startTime,
      endTime: projectionEndTime,
      label: '中枢上沿',
      description: isNearUp
        ? `⚠️价格接近中枢上沿(${lastZs.high.toFixed(2)})，突破即三买`
        : `中枢上沿压力位(${lastZs.high.toFixed(2)})`,
      isNear: isNearUp,
    });

    // 下沿突破投射线
    const distDown = Math.abs(lastPrice - lastZs.low);
    const isNearDown = distDown < threshold;
    projections.push({
      type: 'zsBreakoutDown',
      price: lastZs.low,
      time: lastZs.startTime,
      endTime: projectionEndTime,
      label: '中枢下沿',
      description: isNearDown
        ? `⚠️价格接近中枢下沿(${lastZs.low.toFixed(2)})，跌破即三卖`
        : `中枢下沿支撑位(${lastZs.low.toFixed(2)})`,
      isNear: isNearDown,
    });
  }

  // ===== 2. 潜在买卖点预标 =====
  // 价格在中枢上方接近上沿 → 潜在三买
  // 价格在中枢下方接近下沿 → 潜在三卖
  // 价格在中枢内接近下沿 → 潜在二买
  // 价格在中枢内接近上沿 → 潜在二卖
  if (zhongshus.length > 0) {
    const lastZs = zhongshus[zhongshus.length - 1];
    const zsRange = lastZs.high - lastZs.low;
    const nearThreshold = zsRange * 0.10; // 10%中枢高度

    // 潜在三买：价格在中枢上方，接近上沿
    if (lastPrice > lastZs.high && lastPrice < lastZs.high + nearThreshold) {
      projections.push({
        type: 'potentialBuy',
        price: lastPrice,
        time: lastTime,
        endTime: projectionEndTime,
        label: '预3B',
        description: `潜在三买：价格刚突破中枢上沿，若站稳确认三买`,
        isNear: true,
      });
    }
    // 潜在三卖：价格在中枢下方，接近下沿
    if (lastPrice < lastZs.low && lastPrice > lastZs.low - nearThreshold) {
      projections.push({
        type: 'potentialSell',
        price: lastPrice,
        time: lastTime,
        endTime: projectionEndTime,
        label: '预3S',
        description: `潜在三卖：价格刚跌破中枢下沿，若站稳确认三卖`,
        isNear: true,
      });
    }
    // 潜在二买：价格在中枢内，接近下沿
    if (lastPrice >= lastZs.low && lastPrice <= lastZs.high) {
      if (Math.abs(lastPrice - lastZs.low) < nearThreshold) {
        projections.push({
          type: 'potentialBuy',
          price: lastZs.low,
          time: lastTime,
          endTime: projectionEndTime,
          label: '预2B',
          description: `潜在二买：中枢内回踩接近下沿，不破即二买`,
          isNear: true,
        });
      }
      if (Math.abs(lastPrice - lastZs.high) < nearThreshold) {
        projections.push({
          type: 'potentialSell',
          price: lastZs.high,
          time: lastTime,
          endTime: projectionEndTime,
          label: '预2S',
          description: `潜在二卖：中枢内反弹接近上沿，不破即二卖`,
          isNear: true,
        });
      }
    }
  }

  // ===== 3. 未完成分型预警 =====
  // 如果当前K线和前一根K线形成潜在分型，标注可能形成的分型位置
  if (klines.length >= 3) {
    const prev = klines[klines.length - 2];
    const prev2 = klines[klines.length - 3];
    // 潜在顶分型：前一根高点最高，当前K线如果收低于前一根低点则确认
    if (prev.high > prev2.high && prev.high > lastKline.high) {
      // 当前K线若跌破prev的低点，则顶分型确认
      const confirmPrice = prev.low;
      if (lastPrice > confirmPrice) {
        projections.push({
          type: 'pendingFractal',
          price: prev.high,
          time: lastTime,
          endTime: projectionEndTime,
          label: '待顶分',
          description: `未完成顶分型：若价格跌破${confirmPrice.toFixed(2)}则确认顶分型`,
          isNear: lastPrice < prev.high && lastPrice > confirmPrice,
        });
      }
    }
    // 潜在底分型：前一根低点最低，当前K线如果收高于前一根高点则确认
    if (prev.low < prev2.low && prev.low < lastKline.low) {
      const confirmPrice = prev.high;
      if (lastPrice < confirmPrice) {
        projections.push({
          type: 'pendingFractal',
          price: prev.low,
          time: lastTime,
          endTime: projectionEndTime,
          label: '待底分',
          description: `未完成底分型：若价格突破${confirmPrice.toFixed(2)}则确认底分型`,
          isNear: lastPrice > prev.low && lastPrice < confirmPrice,
        });
      }
    }
  }

  // ===== 4. 笔延长投射 =====
  // 如果最后一笔方向确定，沿其方向画虚线投射
  if (bis.length > 0) {
    const lastBi = bis[bis.length - 1];
    // 按笔的斜率延伸
    const barCount = Math.max(1, lastBi.endIndex - lastBi.startIndex);
    const slope = (lastBi.endPrice - lastBi.startPrice) / barCount;
    // 投射3根K线
    const projectedPrice = lastBi.endPrice + slope * 3;

    projections.push({
      type: 'biExtension',
      price: lastBi.endPrice,
      time: lastBi.endTime,
      endTime: lastTime + interval * 3,
      label: lastBi.direction === 'up' ? '笔延↑' : '笔延↓',
      description: `${lastBi.direction === 'up' ? '上升' : '下降'}笔延长投射：按当前斜率预计到达${projectedPrice.toFixed(2)}`,
      isNear: false,
    });

    // 额外标记投射终点
    const priceDist = Math.abs(projectedPrice - lastPrice);
    const priceThreshold = Math.abs(lastBi.endPrice) * 0.01; // 1%的价格波动范围
    if (priceDist < priceThreshold) {
      projections.push({
        type: 'biExtension',
        price: projectedPrice,
        time: lastTime + interval,
        endTime: lastTime + interval * 3,
        label: '投射位',
        description: `笔投射目标位：${projectedPrice.toFixed(2)}`,
        isNear: priceDist < Math.abs(slope) * 2,
      });
    }
  }

  return projections;
}

// ===== 主函数：K线合并 → 分型 → 笔 → 中枢 → 买卖点 → 预警投射 =====
export function calcChan(klines: KlineData[]): ChanResult {
  const merged = mergeKlines(klines);
  const fractals = detectChanFractals(merged);
  const bis = buildBi(fractals, klines);
  const zhongshus = buildZhongshu(bis);
  const signals = detectChanSignals(bis, zhongshus, klines);
  const projections = calcChanProjections(bis, zhongshus, klines);
  return { fractals, bis, zhongshus, signals, projections };
}

// ATR 数组（用于图表绘制）
export function calcATRArray(klines: KlineData[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [];
  if (!klines || klines.length < period + 1) return result;
  for (let i = 0; i < period; i++) result.push(null);
  // 初始 ATR = 前 period 个 TR 的均值
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    atr += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  atr /= period;
  result.push(atr);
  // Wilder's smoothing
  for (let i = period + 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atr = (atr * (period - 1) + tr) / period;
    result.push(atr);
  }
  return result;
}

// VWAP（成交量加权平均价）
// VWAP = Σ(典型价格 × 成交量) / Σ(成交量)
// 典型价格 = (高 + 低 + 收) / 3
// 注意：VWAP 是日内指标，从当日开盘开始累积。这里按传入K线序列从头累积，
// 调用方应保证传入的是当日K线或一个完整周期内的K线。
export function calcVWAPArray(klines: KlineData[]): (number | null)[] {
  const result: (number | null)[] = [];
  if (!klines || klines.length === 0) return result;
  let cumPV = 0; // 累计价格×成交量
  let cumVol = 0; // 累计成交量
  for (let i = 0; i < klines.length; i++) {
    const typicalPrice = (klines[i].high + klines[i].low + klines[i].close) / 3;
    const vol = klines[i].volume || 0;
    cumPV += typicalPrice * vol;
    cumVol += vol;
    if (cumVol > 0) {
      result.push(cumPV / cumVol);
    } else {
      result.push(null);
    }
  }
  return result;
}

// KDJ（随机指标）
// K 线 = RSV 的 EMA（通常 3 周期）
// D 线 = K 的 EMA（通常 3 周期）
// J 线 = 3K - 2D
// RSV = (收盘价 - N日内最低价) / (N日内最高价 - N日内最低价) × 100
export interface KDJData {
  k: (number | null)[];
  d: (number | null)[];
  j: (number | null)[];
  lastK: number;
  lastD: number;
  lastJ: number;
}

export function calcKDJ(klines: KlineData[], n: number = 9, kPeriod: number = 3, dPeriod: number = 3): KDJData | null {
  if (!klines || klines.length < n) return null;

  const kValues: (number | null)[] = [];
  const dValues: (number | null)[] = [];
  const jValues: (number | null)[] = [];

  // 先计算 RSV
  const rsv: (number | null)[] = [];
  for (let i = 0; i < klines.length; i++) {
    if (i < n - 1) {
      rsv.push(null);
      kValues.push(null);
      dValues.push(null);
      jValues.push(null);
      continue;
    }
    // 找 n 日内最高和最低
    let highN = -Infinity;
    let lowN = Infinity;
    for (let j = i - (n - 1); j <= i; j++) {
      if (klines[j].high > highN) highN = klines[j].high;
      if (klines[j].low < lowN) lowN = klines[j].low;
    }
    if (highN === lowN) {
      rsv.push(50); // 极端情况，默认中值
    } else {
      const rsvVal = ((klines[i].close - lowN) / (highN - lowN)) * 100;
      rsv.push(rsvVal);
    }
  }

  // 计算 K 值：K = 前K × (kPeriod-1)/kPeriod + RSV × 1/kPeriod（EMA形式）
  // 初始 K 值（第一个有效 RSV）用 SMA 近似：直接取第一个 RSV
  let k = 50; // 初始值，很多平台默认50
  let d = 50; // 初始值
  for (let i = 0; i < klines.length; i++) {
    if (rsv[i] == null) continue;
    const rsvVal = rsv[i] as number;
    k = (k * (kPeriod - 1) + rsvVal) / kPeriod;
    d = (d * (dPeriod - 1) + k) / dPeriod;
    const j = 3 * k - 2 * d;
    kValues[i] = k;
    dValues[i] = d;
    jValues[i] = j;
  }

  const last = klines.length - 1;
  return {
    k: kValues,
    d: dValues,
    j: jValues,
    lastK: kValues[last] ?? 50,
    lastD: dValues[last] ?? 50,
    lastJ: jValues[last] ?? 50,
  };
}

// ========== 共享：分形检测与波段筛选 ==========
// AB9线（江恩八分法）与斐波那契回调线共用同一套 A/B 点检测逻辑，
// 保证两套画线在任何行情下始终锚定同一个波段、永不互相矛盾。

interface SwingCandidate {
  /** 波段起点价格（上升=低点，下降=高点） */
  startPrice: number;
  /** 波段终点价格（上升=高点，下降=低点） */
  endPrice: number;
  /** 起点在 klines 中的下标 */
  startIdx: number;
  /** 终点在 klines 中的下标 */
  endIdx: number;
  /** 方向 */
  direction: 'up' | 'down';
  /** 波段幅度（绝对值） */
  range: number;
}

/**
 * 分形检测：左右各 strength 根K线确认的局部极值。
 *
 * 相等极值（平顶/平底）的处理：左侧允许相等、右侧要求严格超越，
 * 即平台走势取平台"最后一根"作为分形 —— 避免全严格比较在平顶/平底
 * 结构下漏检极值（漏检后整个顶部无分形高点，画线会直接消失）。
 * 注：最近 strength 根K线永远无法确认为分形（右侧K线数不足），
 * 这是分形确认机制的固有滞后，属正常代价。
 */
function detectFractals(klines: KlineData[], strength = 3): {
  fractalHighs: { idx: number; price: number }[];
  fractalLows: { idx: number; price: number }[];
} {
  const fractalHighs: { idx: number; price: number }[] = [];
  const fractalLows: { idx: number; price: number }[] = [];
  const fbEnd = klines.length - strength - 1;
  for (let i = strength; i <= fbEnd; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= strength; j++) {
      // 左侧允许相等（>= / <=），右侧要求严格超越（> / <）
      if (klines[i].high < klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low > klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) fractalHighs.push({ idx: i, price: klines[i].high });
    if (isLow) fractalLows.push({ idx: i, price: klines[i].low });
  }
  return { fractalHighs, fractalLows };
}

/** 由分形点构建候选波段：低点在前高点在后为上升，反之下降；幅度不足 minPct% 的忽略 */
function buildSwings(
  fractalHighs: { idx: number; price: number }[],
  fractalLows: { idx: number; price: number }[],
  minPct = 2,
): SwingCandidate[] {
  const swings: SwingCandidate[] = [];
  // 上升波段：低点在前，高点在后
  for (const low of fractalLows) {
    for (const high of fractalHighs) {
      if (high.idx > low.idx) {
        const range = high.price - low.price;
        if ((range / low.price) * 100 >= minPct) {
          swings.push({ startPrice: low.price, endPrice: high.price, startIdx: low.idx, endIdx: high.idx, direction: 'up', range });
        }
      }
    }
  }
  // 下降波段：高点在前，低点在后
  for (const high of fractalHighs) {
    for (const low of fractalLows) {
      if (low.idx > high.idx && high.price > low.price) {
        const range = high.price - low.price;
        if ((range / high.price) * 100 >= minPct) {
          swings.push({ startPrice: high.price, endPrice: low.price, startIdx: high.idx, endIdx: low.idx, direction: 'down', range });
        }
      }
    }
  }
  return swings;
}

/**
 * 选定用于画线的波段：
 * 1. 常规：当前价包含于波段区间内 → 取幅度最大者（与原行为一致）；
 * 2. 向上突破（价格高于所有波段高点）→ 取被突破的、终点最高的上升波段。
 *    其 9线/斐波扩展位恰好构成突破后的目标参考。
 *    修复：此前会一律回退到窗口内"幅度最大"的波段 —— 可能是久远的无关
 *    大波段，甚至是方向相反的下降波段，导致突破后画线整体跳走；
 * 3. 向下跌破（价格低于所有波段低点）→ 镜像取终点最低的下降波段；
 * 4. 单边行情兜底（向上）：价格已越过全部已确认分形高点（创新高但高点
 *    尚未确认，或窗口内根本无可用波段）→ 锚定"最近确认分形低点 → 其后
 *    运行最高点"，与手动把工具拖到当前最高价的行为一致。
 *    修复：纯单边行情下分形高点无法确认 → 此前直接返回 null 不画线；
 * 5. 单边行情兜底（向下）：镜像；
 * 6. 兜底 → 取最近完成的波段（endIdx 最大）。
 */
function selectSwing(
  klines: KlineData[],
  swings: SwingCandidate[],
  fractalHighs: { idx: number; price: number }[],
  fractalLows: { idx: number; price: number }[],
  currentPrice: number,
): SwingCandidate | null {
  // 1. 当前价在波段区间内：幅度最大者优先
  const containing = swings.filter((s) => {
    const lo = Math.min(s.startPrice, s.endPrice);
    const hi = Math.max(s.startPrice, s.endPrice);
    return currentPrice > lo && currentPrice < hi;
  });
  if (containing.length > 0) {
    return [...containing].sort((a, b) => b.range - a.range)[0];
  }

  // 2. 向上突破：在所有被向上突破的上升波段中，取终点（高点）最高、幅度最大者
  const brokenUp = swings.filter(
    (s) => s.direction === 'up' && currentPrice > Math.max(s.startPrice, s.endPrice),
  );
  if (brokenUp.length > 0) {
    return [...brokenUp].sort((a, b) => b.endPrice - a.endPrice || b.range - a.range)[0];
  }

  // 3. 向下跌破：在所有被向下跌破的下降波段中，取终点（低点）最低、幅度最大者
  const brokenDown = swings.filter(
    (s) => s.direction === 'down' && currentPrice < Math.min(s.startPrice, s.endPrice),
  );
  if (brokenDown.length > 0) {
    return [...brokenDown].sort((a, b) => a.endPrice - b.endPrice || b.range - a.range)[0];
  }

  // 4. 单边上涨兜底：价格越过全部已确认分形高点 → 最近确认低点 → 运行最高点
  //    （分形高点为空时视为成立 —— 单边上涨中高点天然无法确认）
  const maxFractalHigh = fractalHighs.length > 0 ? Math.max(...fractalHighs.map((h) => h.price)) : -Infinity;
  if (currentPrice > maxFractalHigh && fractalLows.length > 0) {
    const anchor = fractalLows[fractalLows.length - 1];
    if (currentPrice > anchor.price) {
      let runHigh = -Infinity;
      let runHighIdx = anchor.idx;
      for (let i = anchor.idx; i < klines.length; i++) {
        if (klines[i].high > runHigh) { runHigh = klines[i].high; runHighIdx = i; }
      }
      if (runHigh > anchor.price && ((runHigh - anchor.price) / anchor.price) * 100 >= 2) {
        return { startPrice: anchor.price, endPrice: runHigh, startIdx: anchor.idx, endIdx: runHighIdx, direction: 'up', range: runHigh - anchor.price };
      }
    }
  }

  // 5. 单边下跌兜底：镜像（价格低于全部已确认分形低点 → 最近确认高点 → 运行最低点）
  const minFractalLow = fractalLows.length > 0 ? Math.min(...fractalLows.map((l) => l.price)) : Infinity;
  if (currentPrice < minFractalLow && fractalHighs.length > 0) {
    const anchor = fractalHighs[fractalHighs.length - 1];
    if (currentPrice < anchor.price) {
      let runLow = Infinity;
      let runLowIdx = anchor.idx;
      for (let i = anchor.idx; i < klines.length; i++) {
        if (klines[i].low < runLow) { runLow = klines[i].low; runLowIdx = i; }
      }
      if (anchor.price > runLow && ((anchor.price - runLow) / anchor.price) * 100 >= 2) {
        return { startPrice: anchor.price, endPrice: runLow, startIdx: anchor.idx, endIdx: runLowIdx, direction: 'down', range: anchor.price - runLow };
      }
    }
  }

  // 6. 兜底：最近完成的波段（endIdx 最大，幅度大者优先）
  if (swings.length === 0) return null;
  return [...swings].sort((a, b) => b.endIdx - a.endIdx || b.range - a.range)[0];
}

// ========== 斐波那契回调线 ==========

export interface FibonacciLevel {
  /** 比例系数，如 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618 */
  ratio: number;
  /** 对应价格 */
  price: number;
  /** 标签，如 "0.0", "23.6", "38.2", "50.0", "61.8", "78.6", "100.0", "161.8", "261.8" */
  label: string;
  /** 类型：回调（0-1之间）或扩展（>1） */
  type: 'retracement' | 'extension';
}

export interface FibonacciAnalysis {
  /** A点价格（波段起点） */
  pointA: number;
  /** B点价格（波段终点） */
  pointB: number;
  /** A点时间 */
  timeA: number;
  /** B点时间 */
  timeB: number;
  /** AB段高度（绝对值） */
  height: number;
  /** 方向 */
  direction: 'up' | 'down';
  /** 斐波那契水平线 */
  levels: FibonacciLevel[];
  /** 当前价靠近哪个水平（null=不在任何线附近） */
  nearLevel: number | null;
  /** 当前价在哪个区间 */
  betweenLevels: string;
}

/**
 * 斐波那契回调线算法
 *
 * 基于 AB9 线的分形检测找到最大波段，然后计算斐波那契水平：
 * - 回调位：0%, 23.6%, 38.2%, 50%, 61.8%, 78.6%, 100%
 * - 扩展位：161.8%, 261.8%
 *
 * 上升趋势（A=低点, B=高点）：
 *   回调位价格 = B - height * ratio
 *   扩展位价格 = B + height * (ratio - 1)
 *
 * 下降趋势（A=高点, B=低点）：
 *   回调位价格 = B + height * ratio
 *   扩展位价格 = B - height * (ratio - 1)
 */
export function calcFibonacci(klines: KlineData[]): FibonacciAnalysis | null {
  if (!klines || klines.length < 30) return null;

  const currentPrice = klines[klines.length - 1].close;

  // 1. 分形检测 + 波段筛选（与 AB9线 共用同一套逻辑，两套画线始终锚定同一组 A/B 点）
  const { fractalHighs, fractalLows } = detectFractals(klines);
  // 仅当两侧分形全为空才放弃：单边上涨行情中分形高点天然无法确认（反之亦然），
  // 此时恰是 selectSwing 单边兜底的用武之地。此前用 || 判断会把这类行情
  // 全部提前拦截 → 画线消失（正是要修复的 bug）。
  if (fractalHighs.length === 0 && fractalLows.length === 0) return null;

  const allSwings = buildSwings(fractalHighs, fractalLows);
  // 注意：候选波段为空不提前返回 —— 纯单边行情可能凑不出任何满足幅度阈值的
  // 完整波段，此时由 selectSwing 的兜底分支直接以「分形锚点 → 运行极值」构造

  // 2. 选波段：当前价包含于区间内取幅度最大者；突破时取被突破的波段（见 selectSwing）
  const selected = selectSwing(klines, allSwings, fractalHighs, fractalLows, currentPrice);
  if (!selected) return null;

  // 3. 计算斐波那契水平
  const pointA = selected.startPrice;
  const pointB = selected.endPrice;
  const height = Math.abs(pointB - pointA);

  // 斐波那契比例：回调 + 扩展
  const fibRatios = [
    { ratio: 0, label: '0.0', type: 'retracement' as const },
    { ratio: 0.236, label: '23.6', type: 'retracement' as const },
    { ratio: 0.382, label: '38.2', type: 'retracement' as const },
    { ratio: 0.5, label: '50.0', type: 'retracement' as const },
    { ratio: 0.618, label: '61.8', type: 'retracement' as const },
    { ratio: 0.786, label: '78.6', type: 'retracement' as const },
    { ratio: 1.0, label: '100.0', type: 'retracement' as const },
    { ratio: 1.618, label: '161.8', type: 'extension' as const },
    { ratio: 2.618, label: '261.8', type: 'extension' as const },
  ];

  const levels: FibonacciLevel[] = fibRatios.map(({ ratio, label, type }) => {
    let price: number;
    if (selected.direction === 'up') {
      // 上升趋势：0%~100% 回调位从高点 B 往回算（0% = B，100% = A）；
      // >100% 扩展位从 B 向上投影：161.8% = B + H×0.618（即 A + H×1.618）
      price = ratio <= 1 ? pointB - height * ratio : pointB + height * (ratio - 1);
    } else {
      // 下降趋势：0%~100% 回调位从低点 B 往回算（0% = B，100% = A）；
      // >100% 扩展位从 B 向下投影：161.8% = B − H×0.618（即 A − H×1.618）
      price = ratio <= 1 ? pointB + height * ratio : pointB - height * (ratio - 1);
    }
    return { ratio, price, label, type };
  });

  // 4. 判断当前价靠近哪个水平
  const threshold = height * 0.01; // 1% of AB height
  let nearLevel: number | null = null;
  for (const level of levels) {
    if (Math.abs(currentPrice - level.price) <= threshold) {
      nearLevel = level.ratio;
      break;
    }
  }

  // 5. 判断当前价在哪个区间
  let betweenLevels = '';
  const sortedLevels = [...levels].sort((a, b) => a.price - b.price);
  for (let i = 0; i < sortedLevels.length - 1; i++) {
    if (currentPrice >= sortedLevels[i].price && currentPrice <= sortedLevels[i + 1].price) {
      betweenLevels = `${sortedLevels[i].label}% - ${sortedLevels[i + 1].label}%`;
      break;
    }
  }
  if (!betweenLevels) {
    if (currentPrice > sortedLevels[sortedLevels.length - 1].price) {
      betweenLevels = `${sortedLevels[sortedLevels.length - 1].label}% 之上`;
    } else {
      betweenLevels = `${sortedLevels[0].label}% 之下`;
    }
  }

  return {
    pointA,
    pointB,
    timeA: klines[selected.startIdx].time,
    timeB: klines[selected.endIdx].time,
    height,
    direction: selected.direction,
    levels,
    nearLevel,
    betweenLevels,
  };
}

// ========== AB9线（江恩八分法趋势强度）==========

export interface AB9Line {
  /** 线号 1-9 */
  lineNo: number;
  /** 比例系数（1/8 ~ 9/8） */
  ratio: number;
  /** 对应价格 */
  price: number;
  /** 标签：1线、2线...9线 */
  label: string;
}

export interface AB9Analysis {
  /** A点价格 */
  pointA: number;
  /** B点价格 */
  pointB: number;
  /** A点时间 */
  timeA: number;
  /** B点时间 */
  timeB: number;
  /** AB段高度 */
  height: number;
  /** 方向 */
  direction: 'up' | 'down';
  /** 9条线 */
  lines: AB9Line[];
  /** 当前价在第几条线附近（null=不在任何线附近） */
  nearLine: number | null;
  /** 趋势强度评级 */
  strength: '较强趋势' | '一般趋势' | '较弱趋势' | '趋势破坏';
  /** 当前价在哪两条线之间 */
  betweenLines: string;
  /** 操作建议 */
  advice: string;
}

/**
 * AB9线算法（江恩八分法）
 *
 * 上升趋势：A=低点，B=高点，9线从A往B方向画
 *   1线 = A + H × 1/8
 *   2线 = A + H × 2/8
 *   ...
 *   8线 = A + H × 8/8 = B
 *   9线 = A + H × 9/8（扩展）
 *
 * 下降趋势：A=高点，B=低点，9线从A往B方向画
 *
 * 强度判断：
 *   上升趋势回调时：
 *     - 在5线（5/8 = 0.625）之上企稳 = 较强趋势
 *     - 在4-5线之间 = 一般趋势
 *     - 跌破4线（中轴） = 较弱趋势
 *     - 跌破3线 = 趋势破坏
 */
export function calcAB9Lines(klines: KlineData[]): AB9Analysis | null {
  if (!klines || klines.length < 30) return null;

  const currentPrice = klines[klines.length - 1].close;

  // 1. 分形检测 + 波段筛选（与斐波那契共用同一套逻辑，两套画线始终锚定同一组 A/B 点）
  const { fractalHighs, fractalLows } = detectFractals(klines);
  // 仅当两侧分形全为空才放弃：单边行情下一侧分形为空是常态，
  // 交给 selectSwing 的单边兜底分支处理（此前 || 会提前拦截 → 画线消失）
  if (fractalHighs.length === 0 && fractalLows.length === 0) return null;

  const allSwings = buildSwings(fractalHighs, fractalLows);
  // 注意：候选波段为空不提前返回 —— 纯单边行情可能凑不出任何满足幅度阈值的
  // 完整波段，此时由 selectSwing 的兜底分支直接以「分形锚点 → 运行极值」构造

  // 2. 选波段：当前价包含于区间内取幅度最大者；突破时取被突破的波段（见 selectSwing）
  const selected = selectSwing(klines, allSwings, fractalHighs, fractalLows, currentPrice);
  if (!selected) return null;

  // 3. 计算9条线
  const pointA = selected.startPrice;
  const pointB = selected.endPrice;
  const height = Math.abs(pointB - pointA);
  const lines: AB9Line[] = [];

  for (let i = 1; i <= 9; i++) {
    const ratio = i / 8;
    let price: number;
    if (selected.direction === 'up') {
      price = pointA + height * ratio;
    } else {
      price = pointA - height * ratio;
    }
    lines.push({ lineNo: i, ratio, price, label: `${i}线` });
  }

  // 4. 判断当前价在哪条线附近
  const threshold = height * 0.008; // 0.8% of AB height
  let nearLine: number | null = null;
  for (const line of lines) {
    if (Math.abs(currentPrice - line.price) <= threshold) {
      nearLine = line.lineNo;
      break;
    }
  }

  // 5. 趋势强度判断
  let trendStrength: AB9Analysis['strength'];
  let advice: string;
  let betweenLines = '';

  // 找当前价在哪两条线之间
  for (let i = 0; i < lines.length - 1; i++) {
    const lo = Math.min(lines[i].price, lines[i + 1].price);
    const hi = Math.max(lines[i].price, lines[i + 1].price);
    if (currentPrice >= lo && currentPrice <= hi) {
      betweenLines = `${lines[i].label} - ${lines[i + 1].label}`;
      break;
    }
  }
  if (!betweenLines) {
    // 超出9线范围
    if (selected.direction === 'up' && currentPrice > lines[lines.length - 1].price) {
      betweenLines = `9线之上（扩展区）`;
    } else if (selected.direction === 'up' && currentPrice < lines[0].price) {
      betweenLines = `1线之下（破位）`;
    } else if (selected.direction === 'down' && currentPrice < lines[lines.length - 1].price) {
      betweenLines = `9线之下（扩展区）`;
    } else {
      betweenLines = `1线之上（破位）`;
    }
  }

  // 强度判定
  if (selected.direction === 'up') {
    // 上升趋势回调
    const line5 = lines[4].price; // 5线 = 5/8 = 0.625
    const line4 = lines[3].price; // 4线 = 4/8 = 0.500
    const line3 = lines[2].price; // 3线 = 3/8 = 0.375

    if (currentPrice >= line5) {
      trendStrength = '较强趋势';
      advice = '回调在5线（5/8）之上，趋势强劲，积极做多';
    } else if (currentPrice >= line4) {
      trendStrength = '一般趋势';
      advice = '回调在4-5线之间，趋势一般，谨慎做多';
    } else if (currentPrice >= line3) {
      trendStrength = '较弱趋势';
      advice = '跌破4线中轴，趋势转弱，观望或减仓';
    } else {
      trendStrength = '趋势破坏';
      advice = '跌破3线，上升趋势可能已破坏，离场观望';
    }
  } else {
    // 下降趋势反弹
    const line5 = lines[4].price;
    const line4 = lines[3].price;
    const line3 = lines[2].price;

    if (currentPrice <= line5) {
      trendStrength = '较强趋势';
      advice = '反弹在5线之下，下跌强劲，积极做空';
    } else if (currentPrice <= line4) {
      trendStrength = '一般趋势';
      advice = '反弹在4-5线之间，趋势一般，谨慎做空';
    } else if (currentPrice <= line3) {
      trendStrength = '较弱趋势';
      advice = '突破4线中轴，下跌转弱，观望或减空';
    } else {
      trendStrength = '趋势破坏';
      advice = '突破3线，下降趋势可能已破坏，离场观望';
    }
  }

  return {
    pointA,
    pointB,
    timeA: klines[selected.startIdx].time,
    timeB: klines[selected.endIdx].time,
    height,
    direction: selected.direction,
    lines,
    nearLine,
    strength: trendStrength,
    betweenLines,
    advice,
  };
}

// ========== 多周期趋势（结构法）==========

/** 趋势方向 */
export type TrendDirection = 'bullish' | 'bearish' | 'neutral';

/** 单周期趋势信号（多周期趋势卡片用） */
export interface TrendSignal {
  /** 趋势方向 */
  direction: TrendDirection;
  /** 结构强度：strong（高低点同步）/ weak（仅单侧确认）/ neutral */
  strength: 'strong' | 'weak' | 'neutral';
  /** 评级标签：强多头 / 偏多 / 震荡 / 偏空 / 强空头 */
  label: string;
  /** 最新收盘价 */
  price: number;
  /** 最近确认分形高点（结构上沿） */
  lastHigh: number | null;
  /** 最近确认分形低点（结构下沿） */
  lastLow: number | null;
  /** 最近一根K线的涨跌幅 %（相对前一收盘价） */
  changePercent: number;
}

/**
 * 纯结构趋势判定：完全基于高低点结构，不加权、不打分。
 *
 * 道氏理论核心定义：
 *   上升趋势 = 更高的高点（HH） + 更高的低点（HL）
 *   下降趋势 = 更低的高点（LH） + 更低的低点（LL）
 *
 * 五种结构状态（无任何人为加权，纯结构推导）：
 *
 *   强多头  HH 且 HL       高点递升 + 低点递升，趋势完整确认
 *   偏多    仅 HL          低点已抬升，高点尚未突破（酝酿中）
 *   震荡    HH 与 LL 不一致  或分形不足无法判定
 *   偏空    仅 LH          高点已下降，低点尚未跌破（酝酿中）
 *   强空头  LH 且 LL       高点递降 + 低点递降，趋势完整确认
 *
 * 为什么不用打分：
 *   - 加减分是人为加权，"高点+1、低点+1、波段+1" 的权重没有客观依据
 *   - 结构本身就是趋势的定义，不是"得分越高趋势越强"，而是"结构是否成立"
 *   - 最近波段方向是高低点结构的结果，不应作为第三项重复计分
 *
 * 比较带 1e-6 相对容差，避免浮点噪声把"平顶/平底"误判。
 * 高点或低点不足 2 个分形时，对应侧视为"无法判定"。
 */
export function calcTrendSignal(klines: KlineData[]): TrendSignal | null {
  if (!klines || klines.length < 20) return null;

  const last = klines.length - 1;
  const price = klines[last].close;
  const prevClose = klines[last - 1]?.close ?? price;
  const changePercent = prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  // 复用项目已有的分形检测（strength=3，左右各 3 根确认的局部极值）
  const { fractalHighs, fractalLows } = detectFractals(klines);

  // 相对容差：按价格量级缩放（ETH≈3000 时约 0.003 USDT）
  const eps = Math.max(price, 1) * 1e-6;

  // 高点结构：最近 2 个分形高点
  const highs = fractalHighs.slice(-2);
  let hh = false; // higher high  高点递升
  let lh = false; // lower high   高点递降
  if (highs.length === 2) {
    if (highs[1].price > highs[0].price + eps) hh = true;
    else if (highs[1].price < highs[0].price - eps) lh = true;
  }

  // 低点结构：最近 2 个分形低点
  const lows = fractalLows.slice(-2);
  let hl = false; // higher low   低点递升
  let ll = false; // lower low    低点递降
  if (lows.length === 2) {
    if (lows[1].price > lows[0].price + eps) hl = true;
    else if (lows[1].price < lows[0].price - eps) ll = true;
  }

  // 纯结构判定，不加权不打分
  let direction: TrendDirection;
  let strength: 'strong' | 'weak' | 'neutral';
  let label: string;

  if (hh && hl) {
    // 高点递升 + 低点递升 → 完整上升趋势
    direction = 'bullish';
    strength = 'strong';
    label = '强多头';
  } else if (lh && ll) {
    // 高点递降 + 低点递降 → 完整下降趋势
    direction = 'bearish';
    strength = 'strong';
    label = '强空头';
  } else if (hl && !lh && !ll) {
    // 仅低点抬升（高点方向不明）→ 偏多酝酿
    direction = 'bullish';
    strength = 'weak';
    label = '偏多';
  } else if (lh && !hl && !hh) {
    // 仅高点下降（低点方向不明）→ 偏空酝酿
    direction = 'bearish';
    strength = 'weak';
    label = '偏空';
  } else {
    // 结构不一致（HH+LL / LH+HL）或分形不足 → 震荡
    direction = 'neutral';
    strength = 'neutral';
    label = '震荡';
  }

  const lastHigh = fractalHighs.length > 0 ? fractalHighs[fractalHighs.length - 1].price : null;
  const lastLow = fractalLows.length > 0 ? fractalLows[fractalLows.length - 1].price : null;

  return { direction, strength, label, price, lastHigh, lastLow, changePercent };
}

// ========== 神奇九转（TD Sequential / Nine Turn） ==========
// 标准 TD Sequential 规则：
// 1. 底部九转（买入信号）：连续9根K线，每根收盘价 < 各自往前第4根的收盘价
// 2. 顶部九转（卖出信号）：连续9根K线，每根收盘价 > 各自往前第4根的收盘价
// 3. 序列必须连续，一旦中断（条件不满足）则计数归零
// 4. 只有走到9的序列才确认有效（1-8为临时数字，未到9则不显示）
// 5. 9之后重置，下一根满足条件的K线从1重新开始
// 返回值：正数=底部九转（K线下方，买入），负数=顶部九转（K线上方，卖出），0=无

export interface NineTurnResult {
  value: number;
}

export function calcNineTurn(klines: KlineData[]): NineTurnResult[] {
  const n = klines.length;
  const result: NineTurnResult[] = new Array(n);
  for (let i = 0; i < n; i++) result[i] = { value: 0 };

  if (n < 5) return result;

  // 扫描所有连续序列，记录每个序列的起点、长度、方向
  const sequences: { start: number; length: number; isBuy: boolean }[] = [];

  let i = 4;
  while (i < n) {
    const currentClose = klines[i].close;
    const refClose = klines[i - 4].close;

    if (currentClose === refClose) {
      i++;
      continue;
    }

    const isBuy = currentClose < refClose;

    // 计算连续满足条件的K线数量
    let count = 0;
    let j = i;
    while (j < n) {
      if (j < 4) break;
      const meets = isBuy
        ? klines[j].close < klines[j - 4].close
        : klines[j].close > klines[j - 4].close;
      if (!meets) break;
      count++;
      j++;
    }

    sequences.push({ start: i, length: count, isBuy });
    i = j;
  }

  // 标记结果：
  // - 已完成的序列（长度 >= 9）：显示 1-9
  // - 最后一个进行中的序列：显示临时数字 1~length（可能会消失）
  // - 历史上未完成的序列（长度 < 9）：不显示
  for (let s = 0; s < sequences.length; s++) {
    const seq = sequences[s];
    const isLast = s === sequences.length - 1;

    if (seq.length >= 9) {
      // 完成的序列：显示 1-9（超过9的部分不显示，等下一轮）
      for (let k = 0; k < 9; k++) {
        result[seq.start + k] = { value: seq.isBuy ? (k + 1) : -(k + 1) };
      }
    } else if (isLast && seq.length >= 1) {
      // 当前进行中的序列：显示临时数字（未来可能消失）
      for (let k = 0; k < seq.length; k++) {
        result[seq.start + k] = { value: seq.isBuy ? (k + 1) : -(k + 1) };
      }
    }
    // 历史上未完成的序列（长度 < 9）：不显示任何数字
  }

  return result;
}

