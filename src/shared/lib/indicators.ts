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

  // 1. 找分形点（复用 AB9 的分形检测逻辑）
  const strength = 3;
  const fbStart = strength;
  const fbEnd = klines.length - strength - 1;
  const fractalHighs: { idx: number; price: number }[] = [];
  const fractalLows: { idx: number; price: number }[] = [];

  for (let i = fbStart; i <= fbEnd; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) fractalHighs.push({ idx: i, price: klines[i].high });
    if (isLow) fractalLows.push({ idx: i, price: klines[i].low });
  }

  if (fractalHighs.length === 0 || fractalLows.length === 0) return null;

  // 2. 找包含当前价的最大波段
  type Swing = { startPrice: number; endPrice: number; startIdx: number; endIdx: number; direction: 'up' | 'down'; range: number };
  const allSwings: Swing[] = [];

  // 上升波段：低点在前，高点在后
  for (const low of fractalLows) {
    for (const high of fractalHighs) {
      if (high.idx > low.idx) {
        const range = high.price - low.price;
        if ((range / low.price) * 100 >= 2) {
          allSwings.push({ startPrice: low.price, endPrice: high.price, startIdx: low.idx, endIdx: high.idx, direction: 'up', range });
        }
      }
    }
  }

  // 下降波段
  for (const high of fractalHighs) {
    for (const low of fractalLows) {
      if (low.idx > high.idx && high.price > low.price) {
        const range = high.price - low.price;
        if ((range / high.price) * 100 >= 2) {
          allSwings.push({ startPrice: high.price, endPrice: low.price, startIdx: high.idx, endIdx: low.idx, direction: 'down', range });
        }
      }
    }
  }

  if (allSwings.length === 0) return null;

  // 选波段：当前价在范围内优先，否则取最大
  let selected = allSwings
    .filter((s) => {
      const lo = Math.min(s.startPrice, s.endPrice);
      const hi = Math.max(s.startPrice, s.endPrice);
      return currentPrice > lo && currentPrice < hi;
    })
    .sort((a, b) => b.range - a.range)[0]
    || allSwings.sort((a, b) => b.range - a.range)[0];

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
      // 上升趋势：从高点B往回算回调，往前算扩展
      price = pointB - height * ratio;
    } else {
      // 下降趋势：从低点B往回算回调，往前算扩展
      price = pointB + height * ratio;
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

// ========== 自动划线：支撑/阻力位 ==========

export interface SupportResistanceLine {
  /** 价格水平 */
  price: number;
  /** 类型：支撑或阻力 */
  type: 'support' | 'resistance';
  /** 强度（被测试次数） */
  strength: number;
  /** 最近一次触及的K线索引 */
  lastTouchIdx: number;
}

export interface AutoLinesAnalysis {
  /** 支撑位数组（从低到高） */
  supports: SupportResistanceLine[];
  /** 阻力位数组（从低到高） */
  resistances: SupportResistanceLine[];
  /** 上升趋势线点（两个点） */
  uptrendLine: { time1: number; price1: number; time2: number; price2: number } | null;
  /** 下降趋势线点（两个点） */
  downtrendLine: { time1: number; price1: number; time2: number; price2: number } | null;
}

/**
 * 自动识别支撑/阻力位和趋势线
 *
 * 算法：
 * 1. 基于分形高点/低点聚类，找出价格密集区
 * 2. 同一价格区间内的多个分形点合并为一条支撑/阻力线
 * 3. 被测试次数越多，强度越高
 *
 * 趋势线：
 * - 上升趋势线：连接最近的两个抬高的低点
 * - 下降趋势线：连接最近的两个降低的高点
 */
export function calcAutoLines(klines: KlineData[]): AutoLinesAnalysis | null {
  if (!klines || klines.length < 50) return null;

  // 1. 找分形点
  const strength = 2;
  const fbStart = strength;
  const fbEnd = klines.length - strength - 1;
  const fractalHighs: { idx: number; price: number }[] = [];
  const fractalLows: { idx: number; price: number }[] = [];

  for (let i = fbStart; i <= fbEnd; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) fractalHighs.push({ idx: i, price: klines[i].high });
    if (isLow) fractalLows.push({ idx: i, price: klines[i].low });
  }

  if (fractalHighs.length === 0 || fractalLows.length === 0) return null;

  // 2. 计算价格范围用于聚类阈值
  const priceRange = klines[klines.length - 1].high - klines[0].low;
  const clusterThreshold = priceRange * 0.015; // 1.5% 作为聚类阈值

  // 3. 聚类支撑位（低点）
  const supports = clusterFractals(fractalLows, clusterThreshold, 'support', klines);
  // 4. 聚类阻力位（高点）
  const resistances = clusterFractals(fractalHighs, clusterThreshold, 'resistance', klines);

  // 5. 计算趋势线
  const uptrendLine = calcUptrendLine(fractalLows, klines);
  const downtrendLine = calcDowntrendLine(fractalHighs, klines);

  return {
    supports: supports.sort((a, b) => a.price - b.price),
    resistances: resistances.sort((a, b) => a.price - b.price),
    uptrendLine,
    downtrendLine,
  };
}

/**
 * 将分形点聚类为支撑/阻力线
 */
function clusterFractals(
  fractals: { idx: number; price: number }[],
  threshold: number,
  type: 'support' | 'resistance',
  klines: KlineData[]
): SupportResistanceLine[] {
  if (fractals.length === 0) return [];

  // 按价格排序
  const sorted = [...fractals].sort((a, b) => a.price - b.price);
  const clusters: { prices: number[]; indices: number[] }[] = [];

  let currentCluster = { prices: [sorted[0].price], indices: [sorted[0].idx] };

  for (let i = 1; i < sorted.length; i++) {
    const avgPrice = currentCluster.prices.reduce((s, p) => s + p, 0) / currentCluster.prices.length;
    if (Math.abs(sorted[i].price - avgPrice) <= threshold) {
      currentCluster.prices.push(sorted[i].price);
      currentCluster.indices.push(sorted[i].idx);
    } else {
      clusters.push(currentCluster);
      currentCluster = { prices: [sorted[i].price], indices: [sorted[i].idx] };
    }
  }
  clusters.push(currentCluster);

  // 过滤掉只有1个点的弱支撑/阻力
  const strongClusters = clusters.filter((c) => c.prices.length >= 2);

  // 转换为支撑/阻力线
  return strongClusters.map((c) => {
    const avgPrice = c.prices.reduce((s, p) => s + p, 0) / c.prices.length;
    const lastTouchIdx = Math.max(...c.indices);
    return {
      price: avgPrice,
      type,
      strength: c.prices.length,
      lastTouchIdx,
    };
  }).sort((a, b) => a.price - b.price);
}

/**
 * 计算上升趋势线：连接最近的两个抬高的低点
 */
function calcUptrendLine(
  fractalLows: { idx: number; price: number }[],
  klines: KlineData[]
): { time1: number; price1: number; time2: number; price2: number } | null {
  // 按索引排序（从新到旧）
  const sorted = [...fractalLows].sort((a, b) => b.idx - a.idx);
  if (sorted.length < 2) return null;

  // 找最近的两个抬高的低点
  let point1 = sorted[0]; // 最新的低点
  let point2: { idx: number; price: number } | null = null;

  for (let i = 1; i < sorted.length; i++) {
    // 找到一个比 point1 更早且价格更低的低点
    if (sorted[i].idx < point1.idx && sorted[i].price < point1.price) {
      point2 = sorted[i];
      break;
    }
  }

  if (!point2) return null;

  // 确保 point1 是右边的点（时间较新），point2 是左边的点（时间较早）
  const right = point1;
  const left = point2;

  return {
    time1: klines[left.idx].time,
    price1: left.price,
    time2: klines[right.idx].time,
    price2: right.price,
  };
}

/**
 * 计算下降趋势线：连接最近的两个降低的高点
 */
function calcDowntrendLine(
  fractalHighs: { idx: number; price: number }[],
  klines: KlineData[]
): { time1: number; price1: number; time2: number; price2: number } | null {
  // 按索引排序（从新到旧）
  const sorted = [...fractalHighs].sort((a, b) => b.idx - a.idx);
  if (sorted.length < 2) return null;

  // 找最近的两个降低的高点
  let point1 = sorted[0]; // 最新的高点
  let point2: { idx: number; price: number } | null = null;

  for (let i = 1; i < sorted.length; i++) {
    // 找到一个比 point1 更早且价格更高的高点
    if (sorted[i].idx < point1.idx && sorted[i].price > point1.price) {
      point2 = sorted[i];
      break;
    }
  }

  if (!point2) return null;

  // 确保 point1 是右边的点（时间较新），point2 是左边的点（时间较早）
  const right = point1;
  const left = point2;

  return {
    time1: klines[left.idx].time,
    price1: left.price,
    time2: klines[right.idx].time,
    price2: right.price,
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

  // 1. 找分形点
  const strength = 3;
  const fbStart = strength;
  const fbEnd = klines.length - strength - 1;
  const fractalHighs: { idx: number; price: number }[] = [];
  const fractalLows: { idx: number; price: number }[] = [];

  for (let i = fbStart; i <= fbEnd; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) fractalHighs.push({ idx: i, price: klines[i].high });
    if (isLow) fractalLows.push({ idx: i, price: klines[i].low });
  }

  if (fractalHighs.length === 0 || fractalLows.length === 0) return null;

  // 2. 找包含当前价的最大波段
  type Swing = { startPrice: number; endPrice: number; startIdx: number; endIdx: number; direction: 'up' | 'down'; range: number };
  const allSwings: Swing[] = [];

  // 上升波段：低点在前，高点在后（low.idx < high.idx）
  for (const low of fractalLows) {
    for (const high of fractalHighs) {
      if (high.idx > low.idx) {
        const range = high.price - low.price;
        if ((range / low.price) * 100 >= 2) {
          allSwings.push({ startPrice: low.price, endPrice: high.price, startIdx: low.idx, endIdx: high.idx, direction: 'up', range });
        }
      }
    }
  }

  // 下降波段
  for (const high of fractalHighs) {
    for (const low of fractalLows) {
      if (low.idx > high.idx && high.price > low.price) {
        const range = high.price - low.price;
        if ((range / high.price) * 100 >= 2) {
          allSwings.push({ startPrice: high.price, endPrice: low.price, startIdx: high.idx, endIdx: low.idx, direction: 'down', range });
        }
      }
    }
  }

  if (allSwings.length === 0) return null;

  // 选波段：当前价在范围内优先，否则取最大
  let selected = allSwings
    .filter((s) => {
      const lo = Math.min(s.startPrice, s.endPrice);
      const hi = Math.max(s.startPrice, s.endPrice);
      return currentPrice > lo && currentPrice < hi;
    })
    .sort((a, b) => b.range - a.range)[0]
    || allSwings.sort((a, b) => b.range - a.range)[0];

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
