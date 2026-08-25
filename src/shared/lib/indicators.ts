// 技术指标计算 - 移植自 v5.4 版本
// 布林带 / MACD / 斐波那契 / MA / EMA / RSI

import { KlineData } from './market-data';

// EMA（指数移动平均）
// 标准 EMA：前 period 个值用 SMA 作为初始种子值，后续用递推公式
export function ema(values: number[], period: number): number[] {
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

// SMA 数组
export function calcSMAArray(klines: KlineData[], period: number): (number | null)[] {
  const closes = klines.map((k) => k.close);
  const result: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = 0; j < period; j++) sum += closes[i - j];
    result.push(sum / period);
  }
  return result;
}

// ========== 融合信号系统（加权综合所有指标）==========

// ========== 综合交易信号（买入/卖出建议）==========

/** 找最近的结实支撑位（当前价下方） */
function findNearestSupport_(
  currentPrice: number,
  fibLevels: Record<number, number>,
  levelTests: Record<number, LevelTest>,
): { price: number; label: string; strength: number } | null {
  const candidates: { price: number; label: string; strength: number; dist: number }[] = [];
  const labels: Record<number, string> = { 0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5', 618: '0.618', 786: '0.786', 100: '1.0' };
  for (const [kStr, price] of Object.entries(fibLevels)) {
    const k = Number(kStr);
    if (!price || price <= 0 || price >= currentPrice) continue;
    const test = levelTests[k];
    if (test && test.verdict === '结实') {
      candidates.push({ price, label: labels[k] || `${k}`, strength: test.strength, dist: currentPrice - price });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.length > 0 ? candidates[0] : null;
}

/** 找最近的结实阻力位（当前价上方） */
function findNearestResistance_(
  currentPrice: number,
  fibLevels: Record<number, number>,
  levelTests: Record<number, LevelTest>,
): { price: number; label: string; strength: number; dist: number } | null {
  const candidates: { price: number; label: string; strength: number; dist: number }[] = [];
  const labels: Record<number, string> = { 0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5', 618: '0.618', 786: '0.786', 100: '1.0' };
  for (const [kStr, price] of Object.entries(fibLevels)) {
    const k = Number(kStr);
    if (!price || price <= 0 || price <= currentPrice) continue;
    const test = levelTests[k];
    if (test && test.verdict === '结实') {
      candidates.push({ price, label: labels[k] || `${k}`, strength: test.strength, dist: price - currentPrice });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.length > 0 ? candidates[0] : null;
}

/** 找距离当前价最近的结实位（不论支撑阻力） */
function findNearestSolidLevel_(
  currentPrice: number,
  fibLevels: Record<number, number>,
  levelTests: Record<number, LevelTest>,
): { price: number; label: string; strength: number; type: '支撑' | '阻力' } | null {
  const candidates: { price: number; label: string; strength: number; dist: number; type: '支撑' | '阻力' }[] = [];
  const labels: Record<number, string> = { 0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5', 618: '0.618', 786: '0.786', 100: '1.0' };
  for (const [kStr, price] of Object.entries(fibLevels)) {
    const k = Number(kStr);
    if (!price || price <= 0) continue;
    const test = levelTests[k];
    if (test && test.verdict === '结实') {
      const type = price < currentPrice ? '支撑' : '阻力';
      candidates.push({ price, label: labels[k] || `${k}`, strength: test.strength, dist: Math.abs(price - currentPrice), type });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates.length > 0 ? candidates[0] : null;
}


// ========== 结构化交易计划 ==========

// ========== 市场结构识别（SMC 风格）==========

// ========== K 线形态识别 =================

// ========== 布林带状态检测 ==========

// EMA 数组
export function calcEMAArray(klines: KlineData[], period: number): number[] {
  const closes = klines.map((k) => k.close);
  return ema(closes, period);
}

/**
 * ADX（平均方向指数）- 趋势强度
 * ADX > 25：趋势强
 * ADX < 20：震荡无方向
 * 20-25：趋势不明
 */
export function calcADX(klines: KlineData[], period: number = 14): number {
  if (klines.length < period * 2 + 1) return 0;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low;
    const prevH = klines[i - 1].high, prevL = klines[i - 1].low, prevC = klines[i - 1].close;
    const upMove = h - prevH;
    const downMove = prevL - l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
  }

  // Wilder 平滑
  const smoothTR = (arr: number[], p: number): number[] => {
    const out: number[] = [];
    let sum = 0;
    for (let i = 0; i < p && i < arr.length; i++) sum += arr[i];
    out.push(sum);
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      out.push(sum);
    }
    return out;
  };

  const sTR = smoothTR(tr, period);
  const sPDM = smoothTR(plusDM, period);
  const sMDM = smoothTR(minusDM, period);

  const dx: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    if (sTR[i] === 0) { dx.push(0); continue; }
    const pdi = (sPDM[i] / sTR[i]) * 100;
    const mdi = (sMDM[i] / sTR[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  if (dx.length < period) return 0;
  // ADX = Wilder平滑的DX
  let adx = 0;
  for (let i = 0; i < period && i < dx.length; i++) adx += dx[i];
  adx /= period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return adx;
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

// RSI（标准 Wilder's smoothing 方法）
// 第一次用 SMA 初始化平均涨幅/跌幅，后续用平滑公式递推
export function calcRSI(klines: KlineData[], period: number = 14): number | null {
  if (!klines || klines.length < period + 1) return null;
  // 用前 period 个涨跌幅的 SMA 初始化
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  // Wilder's smoothing 递推计算到最后一个数据点
  for (let i = period + 1; i < klines.length; i++) {
    const diff = klines[i].close - klines[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
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

// ========== TD Sequential（九转指标）==========

export interface TDSequentialPoint {
  idx: number;
  time: number;
  price: number;
  num: number;       // 1-9
  type: 'buy' | 'sell';
  completed: boolean; // 是否为完成的9
}

/**
 * TD Sequential 九转指标
 * 买入计数: 收盘价 < 4根前收盘价 则 +1，连续计数到9
 * 卖出计数: 收盘价 > 4根前收盘价 则 +1，连续计数到9
 * 任一条件不满足则归零重新开始
 */
export function calcTDSequential(klines: KlineData[]): TDSequentialPoint[] {
  const points: TDSequentialPoint[] = [];
  if (!klines || klines.length < 5) return points;

  let buyCount = 0;
  let sellCount = 0;

  for (let i = 4; i < klines.length; i++) {
    const close = klines[i].close;
    const compare = klines[i - 4].close;

    // --- 买入计数 ---
    if (close < compare) {
      buyCount++;
      // 超过9归零重新计数（标准TD Sequential）
      if (buyCount > 9) buyCount = 1;
      points.push({
        idx: i,
        time: klines[i].time,
        price: klines[i].low,
        num: buyCount,
        type: 'buy',
        completed: buyCount === 9,
      });
    } else {
      buyCount = 0;
    }

    // --- 卖出计数 ---
    if (close > compare) {
      sellCount++;
      // 超过9归零重新计数（标准TD Sequential）
      if (sellCount > 9) sellCount = 1;
      points.push({
        idx: i,
        time: klines[i].time,
        price: klines[i].high,
        num: sellCount,
        type: 'sell',
        completed: sellCount === 9,
      });
    } else {
      sellCount = 0;
    }
  }

  return points;
}

// 分形点识别
interface Fractal {
  idx: number;
  price: number;
  time: number;
}

function findFractalHighs(klines: KlineData[], strength: number = 5, lookback: number = 150): Fractal[] {
  const fractals: Fractal[] = [];
  const total = klines.length;
  const start = Math.max(strength, total - lookback);
  const end = total - strength - 1;
  for (let i = start; i <= end; i++) {
    let isFractal = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) {
        isFractal = false;
        break;
      }
    }
    if (isFractal) fractals.push({ idx: i, price: klines[i].high, time: klines[i].time });
  }
  return fractals;
}

function findFractalLows(klines: KlineData[], strength: number = 5, lookback: number = 150): Fractal[] {
  const fractals: Fractal[] = [];
  const total = klines.length;
  const start = Math.max(strength, total - lookback);
  const end = total - strength - 1;
  for (let i = start; i <= end; i++) {
    let isFractal = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) {
        isFractal = false;
        break;
      }
    }
    if (isFractal) fractals.push({ idx: i, price: klines[i].low, time: klines[i].time });
  }
  return fractals;
}

// 波段识别
interface Swing {
  high: number;
  low: number;
  highIdx: number;
  lowIdx: number;
  range: number;
  direction: 'up' | 'down';
}

function findSwingHighLow(klines: KlineData[], lookback: number = 100, strength: number = 5): Swing | null {
  const highs = findFractalHighs(klines, strength, lookback);
  const lows = findFractalLows(klines, strength, lookback);
  if (highs.length === 0 || lows.length === 0) return null;

  for (let hi = highs.length - 1; hi >= 0; hi--) {
    const high = highs[hi];
    for (let li = 0; li < lows.length; li++) {
      if (lows[li].idx > high.idx && high.price > lows[li].price) {
        return {
          high: high.price,
          low: lows[li].price,
          highIdx: high.idx,
          lowIdx: lows[li].idx,
          range: high.price - lows[li].price,
          direction: 'down',
        };
      }
    }
  }
  return null;
}

function findSwingLowHigh(klines: KlineData[], lookback: number = 100, strength: number = 5): Swing | null {
  const highs = findFractalHighs(klines, strength, lookback);
  const lows = findFractalLows(klines, strength, lookback);
  if (highs.length === 0 || lows.length === 0) return null;

  for (let li = lows.length - 1; li >= 0; li--) {
    const low = lows[li];
    for (let hi = 0; hi < highs.length; hi++) {
      if (highs[hi].idx > low.idx && highs[hi].price > low.price) {
        return {
          high: highs[hi].price,
          low: low.price,
          highIdx: highs[hi].idx,
          lowIdx: low.idx,
          range: highs[hi].price - low.price,
          direction: 'up',
        };
      }
    }
  }
  return null;
}

// 斐波那契（标准画法：分形波段法，从左往右）
export interface FibonacciData {
  trend: string;
  levels: Record<number, number>;
  startTime: number; // 波段起点时间
  endTime: number;   // 波段终点时间
}

export function calcFibonacci(klines: KlineData[]): FibonacciData | null {
  if (!klines || klines.length < 30) return null;

  // 1. 找分形高点和低点（strength=3）
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

  const currentPrice = klines[klines.length - 1].close;
  const minRangePct = 2.0; // 最小波段幅度 2%（过滤杂波）

  // 2. 找所有完整波段
  type Swing = { start: number; end: number; startIdx: number; endIdx: number; direction: string; range: number };
  const allSwings: Swing[] = [];

  // 下降波段：左高右低
  for (const high of fractalHighs) {
    for (const low of fractalLows) {
      if (low.idx > high.idx && high.price > low.price) {
        const range = high.price - low.price;
        const rangePct = (range / high.price) * 100;
        if (rangePct >= minRangePct) {
          allSwings.push({ start: high.price, end: low.price, startIdx: high.idx, endIdx: low.idx, direction: 'down', range });
        }
      }
    }
  }

  // 上升波段：左低右高
  for (const low of fractalLows) {
    for (const high of fractalHighs) {
      if (high.idx > low.idx && high.price > low.price) {
        const range = high.price - low.price;
        const rangePct = (range / low.price) * 100;
        if (rangePct >= minRangePct) {
          allSwings.push({ start: low.price, end: high.price, startIdx: low.idx, endIdx: high.idx, direction: 'up', range });
        }
      }
    }
  }

  if (allSwings.length === 0) return null;

  // 3. 选择策略（从新到旧，优先选最贴近当前行情的）：
  //   a) 当前价在波段 0~100% 回撤范围内的、最近的、幅度最大的波段
  //   b) 如果没有，找最近一个幅度 >= 3% 的显著波段
  //   c) 兜底：取最大波段

  let selected: Swing | null = null;

  // 策略 a：当前价在波段回撤范围内，优先选幅度大的（避免选到小杂波）
  const containing = allSwings
    .filter((s) => {
      const lo = Math.min(s.start, s.end);
      const hi = Math.max(s.start, s.end);
      return currentPrice > lo && currentPrice < hi; // 严格在范围内
    })
    .sort((a, b) => b.range - a.range); // 幅度大的优先
  if (containing.length > 0) {
    selected = containing[0];
  }

  // 策略 b：最近一个显著波段（幅度 >= 3%）
  if (!selected) {
    const significant = allSwings
      .filter((s) => (s.range / Math.min(s.start, s.end)) * 100 >= 3.0)
      .sort((a, b) => b.endIdx - a.endIdx);
    if (significant.length > 0) {
      selected = significant[0];
    }
  }

  // 策略 c：兜底取最大波段
  if (!selected) {
    selected = allSwings.sort((a, b) => b.range - a.range)[0];
  }

  // 4. 从左往右计算斐波那契级别
  const { start, end, startIdx, endIdx, direction, range } = selected;

  const lv = (ratio: number) => {
    if (direction === 'down') {
      return start - range * ratio; // 下降：从高往低画
    } else {
      return start + range * ratio; // 上升：从低往高画
    }
  };

  return {
    trend: direction === 'down' ? '下降结构' : '上升结构',
    startTime: klines[startIdx].time,
    endTime: klines[endIdx].time,
    levels: {
      0: lv(0),
      236: lv(0.236),
      382: lv(0.382),
      50: lv(0.5),
      618: lv(0.618),
      786: lv(0.786),
      100: lv(1),
      1272: direction === 'down' ? lv(1) - range * 0.272 : lv(1) + range * 0.272,
      1618: direction === 'down' ? lv(1) - range * 0.618 : lv(1) + range * 0.618,
    },
  };
}

// ========== 多时间框架共振 ==========

const RESONANCE_LEVEL_KEYS = [0, 236, 382, 50, 618, 786, 100, 1272, 1618];
const RESONANCE_LEVEL_LABELS: Record<number, string> = {
  0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5',
  618: '0.618', 786: '0.786', 100: '1.0', 1272: 'E1.272', 1618: 'E1.618',
};

// ========== 势能分析 ==========

// ========== 支撑/阻力位测试强度分析 ==========

export interface LevelTest {
  /** 触及次数 */
  touches: number;
  /** 每次触及的反弹幅度（百分比），正=反弹离开，负=穿过 */
  bouncePcts: number[];
  /** 触及时的平均成交量 vs 整体均量 */
  avgTouchVolRatio: number;
  /** 判定：结实/衰减/未测试 */
  verdict: '结实' | '衰减' | '未测试';
  /** 强度 0~100 */
  strength: number;
  /** 一句话信号 */
  signal: string;
}

// ========== ATR 动态止损 ==========

export function calcATR(klines: KlineData[], period: number = 14): number {
  if (klines.length < period + 1) return 0;
  const trValues: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr1 = high - low;
    const tr2 = Math.abs(high - prevClose);
    const tr3 = Math.abs(low - prevClose);
    trValues.push(Math.max(tr1, tr2, tr3));
  }
  const recentTR = trValues.slice(-period);
  return recentTR.reduce((s, v) => s + v, 0) / period;
}

// ========== 多周期趋势过滤 ==========

// ========== FVG（公允价值缺口）识别 ==========

export interface FVG {
  type: 'bullish' | 'bearish';
  start: number;
  end: number;
  startTime: number;
  endTime: number;
  size: number;
  isActive: boolean;
  index: number;
}

// ========== 订单块 (Order Block) 识别 ==========

// ========== 流动性猎杀 (Liquidity Sweep) 检测 ==========

// ========== 底分型 / 顶分型检测 ==========

// ========== 资金管理 ==========

// ========== AB9线（江恩八分法趋势强度） ==========

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

  // 2. 找包含当前价的最大波段（复用斐波那契的选波段逻辑）
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

// ========== AB9 + 分型策略回测 ==========
