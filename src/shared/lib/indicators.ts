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

// ========== 策略信号系统 ==========

export type SignalAction = 'long' | 'short' | 'wait';

export interface StrategySignal {
  /** 操作建议：做多 / 做空 / 观望 */
  action: SignalAction;
  /** 信号强度 */
  strength: 'strong' | 'normal' | 'weak';
  /** 一句话状态描述，如"4h强多 + 1h回调61.8% + 15m止跌，可做多" */
  status: string;
  /** 当前价 */
  price: number;
  /** 参考入场价 */
  entryPrice: number | null;
  /** 止损价（结构止损） */
  stopLoss: number | null;
  /** 第一止盈目标（前高/前低 或 161.8%扩展） */
  target1: number | null;
  /** 第二止盈目标（261.8%扩展） */
  target2: number | null;
  /** 盈亏比 = (目标1 - 入场) / (入场 - 止损)，做多时为正 */
  riskReward: number | null;
  /** 共振等级：0-3，几个周期方向一致 */
  resonanceLevel: number;
  /** 各周期状态摘要 */
  breakdown: {
    large: { label: string; direction: TrendDirection };
    medium: { label: string; direction: TrendDirection; position: string };
    small: { label: string; direction: TrendDirection };
  };
}

/**
 * 三周期共振策略信号计算。
 *
 * 核心逻辑（来自"Alpha 结构交易法"）：
 *   1. 大周期定方向（强多/强空才考虑）
 *   2. 中周期找结构位（回调到 AB9 4-5线 / 斐波那契 50%-61.8%）
 *   3. 小周期确认入场（出现反转结构）
 *   4. 盈亏比 ≥ 2.5 才出手
 *
 * @param largeTrend  大周期趋势（如 4h / 1d）
 * @param mediumKlines 中周期 K 线（如 1h），用于算 AB9 / 斐波那契找结构位
 * @param smallTrend  小周期趋势（如 15m），用于入场确认
 */
export function calcStrategySignal(
  largeTrend: TrendSignal | null,
  mediumKlines: KlineData[],
  smallTrend: TrendSignal | null,
): StrategySignal | null {
  if (!largeTrend) return null;

  const price = largeTrend.price;
  const largeDir = largeTrend.direction;
  const largeStrong = largeTrend.strength === 'strong';

  // 中周期结构分析
  const ab9 = calcAB9Lines(mediumKlines);
  const fib = calcFibonacci(mediumKlines);
  const mediumTrend = calcTrendSignal(mediumKlines);
  const mediumDir = mediumTrend?.direction ?? 'neutral';

  // 小周期
  const smallDir = smallTrend?.direction ?? 'neutral';

  // ===== 共振计数 =====
  let resonance = 0;
  if (largeDir !== 'neutral') resonance++;
  if (mediumDir === largeDir) resonance++;
  if (smallDir === largeDir) resonance++;

  // ===== 中周期位置描述 =====
  let mediumPosition = '结构不明';
  if (ab9) {
    mediumPosition = ab9.betweenLines;
  }

  // ===== 策略判定 =====
  let action: SignalAction = 'wait';
  let strength: 'strong' | 'normal' | 'weak' = 'weak';
  let status = '观望中，等待机会';
  let entryPrice: number | null = null;
  let stopLoss: number | null = null;
  let target1: number | null = null;
  let target2: number | null = null;
  let riskReward: number | null = null;

  // --- 做多条件 ---
  if (largeDir === 'bullish' && largeStrong && ab9 && fib) {
    const ab9Lines = ab9.lines;
    // 找到关键回调位：AB9 的 5线、4线、3线；斐波那契的 50%、61.8%
    // 价格在这些位置附近（±2%以内）且小周期转多 → 入场信号

    const keyLevels: number[] = [];
    // AB9 关键线：5线（5/8）、4线（4/8=中线）
    const line5 = ab9Lines.find((l) => l.lineNo === 5)?.price;
    const line4 = ab9Lines.find((l) => l.lineNo === 4)?.price;
    const line3 = ab9Lines.find((l) => l.lineNo === 3)?.price;
    if (line5 !== undefined) keyLevels.push(line5);
    if (line4 !== undefined) keyLevels.push(line4);

    // 斐波那契关键回调位
    const fib50 = fib.levels.find((l) => Math.abs(l.ratio - 0.5) < 0.001)?.price;
    const fib618 = fib.levels.find((l) => Math.abs(l.ratio - 0.618) < 0.001)?.price;
    if (fib50 !== undefined) keyLevels.push(fib50);
    if (fib618 !== undefined) keyLevels.push(fib618);

    // 判断价格是否在关键位附近（±2%范围视为"到达关键位"）
    const nearKeyLevel = keyLevels.some((lv) => {
      const dist = Math.abs(price - lv) / lv;
      return dist <= 0.02;
    });

    // 小周期是否转多（偏多或强多头）
    const smallBullish = smallDir === 'bullish';

    // 价格所处线号（上升趋势：1线最低=A，8线=B，9线为扩展）
    // 找到价格位于哪两条线之间，取下沿线的 lineNo
    let currentLineNo = 0;
    if (ab9.direction === 'up') {
      // 上升：线号越大价格越高
      for (const ln of ab9Lines) {
        if (price >= ln.price) currentLineNo = ln.lineNo;
      }
    } else {
      // 下降：线号越大价格越低
      for (const ln of ab9Lines) {
        if (price <= ln.price) currentLineNo = ln.lineNo;
      }
    }

    // 中周期是否在回调/反弹区域（3-6线之间，即大约中间区域）
    const inPullbackZone = currentLineNo >= 3 && currentLineNo <= 6;

    if (nearKeyLevel && smallBullish) {
      // 强信号：价格在关键位 + 小周期确认转多
      action = 'long';
      strength = 'strong';
      status = '到达关键位 + 小周期确认，可做多';
    } else if (inPullbackZone && smallDir === 'neutral') {
      // 中等信号：在回调区，小周期还没确认
      action = 'wait';
      strength = 'normal';
      status = '回调中，关注小周期止跌信号';
    } else if (largeStrong && mediumDir === 'bullish' && smallBullish) {
      // 三周期共振但不在回调位 → 偏强的顺势信号（追单风险高，标记为 weak）
      action = 'long';
      strength = 'weak';
      status = '三周期共振但不在回调位，追多需谨慎';
    } else if (largeStrong && !inPullbackZone) {
      action = 'wait';
      strength = 'weak';
      status = '大周期多头，等待回调到关键位';
    }

    // 计算入场/止损/目标
    if (action === 'long' || (inPullbackZone && largeStrong)) {
      // 入场：用最近关键位上方一点作为参考入场（保守：突破关键位）
      const nearbyLevel = keyLevels
        .filter((lv) => price >= lv * 0.98) // 价格在该位上方或附近
        .sort((a, b) => b - a)[0] ?? line4 ?? price;

      entryPrice = Math.round(price * 100) / 100;

      // 止损：最近分形低点下方 1%
      if (mediumTrend?.lastLow) {
        stopLoss = Math.round(mediumTrend.lastLow * 0.99 * 100) / 100;
      } else if (line3 !== undefined) {
        stopLoss = Math.round(line3 * 0.98 * 100) / 100;
      }

      // 目标1：前高（AB9 8线附近 = B点）
      const swingB = fib.levels.find((l) => Math.abs(l.ratio - 0) < 0.001)?.price; // 0% = B点
      const fib1618 = fib.levels.find((l) => Math.abs(l.ratio - 1.618) < 0.001)?.price;
      const fib2618 = fib.levels.find((l) => Math.abs(l.ratio - 2.618) < 0.001)?.price;

      target1 = fib1618 ? Math.round(fib1618 * 100) / 100 : null;
      target2 = fib2618 ? Math.round(fib2618 * 100) / 100 : null;

      if (stopLoss && target1 && entryPrice > stopLoss) {
        const rr = (target1 - entryPrice) / (entryPrice - stopLoss);
        riskReward = Math.round(rr * 100) / 100;

        // 盈亏比不够 2:1 就不建议
        if (action === 'long' && rr < 2) {
          action = 'wait';
          strength = 'weak';
          status = '盈亏比不足，不建议入场，等待更好位置';
        }
      }
    }
  }

  // --- 做空条件（镜像） ---
  else if (largeDir === 'bearish' && largeStrong && ab9 && fib) {
    const ab9Lines = ab9.lines;
    const keyLevels: number[] = [];

    const line5 = ab9Lines.find((l) => l.lineNo === 5)?.price;
    const line4 = ab9Lines.find((l) => l.lineNo === 4)?.price;
    const line6 = ab9Lines.find((l) => l.lineNo === 6)?.price;
    if (line5 !== undefined) keyLevels.push(line5);
    if (line4 !== undefined) keyLevels.push(line4);

    const fib50 = fib.levels.find((l) => Math.abs(l.ratio - 0.5) < 0.001)?.price;
    const fib618 = fib.levels.find((l) => Math.abs(l.ratio - 0.618) < 0.001)?.price;
    if (fib50 !== undefined) keyLevels.push(fib50);
    if (fib618 !== undefined) keyLevels.push(fib618);

    const nearKeyLevel = keyLevels.some((lv) => {
      const dist = Math.abs(price - lv) / lv;
      return dist <= 0.02;
    });

    const smallBearish = smallDir === 'bearish';

    // 价格所处线号（下降：1线最高=A，8线最低=B，9线向下扩展）
    let currentLineNoS = 0;
    if (ab9.direction === 'down') {
      for (const ln of ab9Lines) {
        if (price <= ln.price) currentLineNoS = ln.lineNo;
      }
    } else {
      for (const ln of ab9Lines) {
        if (price >= ln.price) currentLineNoS = ln.lineNo;
      }
    }

    // 下降趋势中，反弹到关键位附近（3-6线之间 = 中间反弹区）
    const inReboundZone = currentLineNoS >= 3 && currentLineNoS <= 6;

    if (nearKeyLevel && smallBearish) {
      action = 'short';
      strength = 'strong';
      status = '反弹到关键位 + 小周期确认，可做空';
    } else if (inReboundZone && smallDir === 'neutral') {
      action = 'wait';
      strength = 'normal';
      status = '反弹中，关注小周期止涨信号';
    } else if (largeStrong && mediumDir === 'bearish' && smallBearish) {
      action = 'short';
      strength = 'weak';
      status = '三周期共振但不在反弹位，追空需谨慎';
    } else if (largeStrong && !inReboundZone) {
      action = 'wait';
      strength = 'weak';
      status = '大周期空头，等待反弹到关键位';
    }

    // 计算点位
    if (action === 'short' || (inReboundZone && largeStrong)) {
      entryPrice = Math.round(price * 100) / 100;

      // 止损：最近分形高点上方 1%
      if (mediumTrend?.lastHigh) {
        stopLoss = Math.round(mediumTrend.lastHigh * 1.01 * 100) / 100;
      } else if (line6 !== undefined) {
        stopLoss = Math.round(line6 * 1.02 * 100) / 100;
      }

      const fib1618 = fib.levels.find((l) => Math.abs(l.ratio - 1.618) < 0.001)?.price;
      const fib2618 = fib.levels.find((l) => Math.abs(l.ratio - 2.618) < 0.001)?.price;

      target1 = fib1618 ? Math.round(fib1618 * 100) / 100 : null;
      target2 = fib2618 ? Math.round(fib2618 * 100) / 100 : null;

      if (stopLoss && target1 && entryPrice < stopLoss) {
        const rr = (entryPrice - target1) / (stopLoss - entryPrice);
        riskReward = Math.round(rr * 100) / 100;

        if (action === 'short' && rr < 2) {
          action = 'wait';
          strength = 'weak';
          status = '盈亏比不足，不建议入场，等待更好位置';
        }
      }
    }
  }

  // --- 震荡或大周期不明确 ---
  else {
    action = 'wait';
    strength = 'weak';
    status = largeDir === 'neutral' ? '大周期震荡，不建议操作' : '大趋势强度不足，观望';
  }

  return {
    action,
    strength,
    status,
    price: Math.round(price * 100) / 100,
    entryPrice,
    stopLoss,
    target1,
    target2,
    riskReward,
    resonanceLevel: resonance,
    breakdown: {
      large: { label: largeTrend.label, direction: largeDir },
      medium: { label: mediumTrend?.label ?? '数据不足', direction: mediumDir, position: mediumPosition },
      small: { label: smallTrend?.label ?? '数据不足', direction: smallDir },
    },
  };
}
