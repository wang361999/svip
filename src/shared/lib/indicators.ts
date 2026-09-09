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

// SMA 数组（简单移动平均；前 period-1 根数据不足时为 null）
export function calcSMAArray(klines: KlineData[], period: number): (number | null)[] {
  const closes = klines.map((k) => k.close);
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
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
    if (avgLoss === 0) { result.push(avgGain === 0 ? 50 : 100); continue; }
    const rs = avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

// ==================== Fourier Extrapolator（傅里叶外推器） ====================
// 将价格分解为主导谐波周期，利用 FFT 外推未来价格走势

export interface FourierPoint {
  time: number;
  price: number;
}

export interface FourierProjection {
  /** 拟合区间内的重构值（验证拟合质量） */
  reconstructed: FourierPoint[];
  /** 未来投影点 */
  projection: FourierPoint[];
  /** 主导周期（以K线根数为单位） */
  dominantCycles: number[];
  /** 拟合度 R²（0~1） */
  rSquared: number;
}

/**
 * 迭代式 radix-2 Cooley-Tukey FFT
 * 输入长度必须为 2 的幂
 */
function fftRadix2(input: number[]): { re: number[]; im: number[] } {
  const n = input.length;
  if (n <= 1) return { re: [...input], im: new Array(n).fill(0) };

  const re = [...input];
  const im = new Array(n).fill(0);

  // Bit-reversal 置换
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // 蝶形运算
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(angle);
    const wlenIm = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * wRe - im[i + k + len / 2] * wIm;
        const vIm = re[i + k + len / 2] * wIm + im[i + k + len / 2] * wRe;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;

        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }

  return { re, im };
}

/**
 * 傅里叶外推预测
 *
 * @param klines    K线数据
 * @param lookback  回溯窗口（实际使用的最大K线数，会自动截取为2的幂）
 * @param numHarmonics 保留的主导谐波数量（越多越拟合历史，但可能过拟合）
 * @param projBars  向前投影的K线根数
 */
export function calcFourierExtrapolation(
  klines: KlineData[],
  lookback: number = 128,
  numHarmonics: number = 8,
  projBars: number = 24,
): FourierProjection | null {
  const n = klines.length;
  if (n < 30) return null;

  // 取最近 lookback 根K线的收盘价
  const startIdx = Math.max(0, n - lookback);
  const closes = klines.slice(startIdx).map((k) => k.close);
  const m = closes.length;

  // 找到 ≤ m 的最大 2 的幂
  const fftSize = Math.pow(2, Math.floor(Math.log2(m)));
  if (fftSize < 16) return null;

  // 截取最后 fftSize 个数据点
  const data = closes.slice(-fftSize);

  // 去均值（消除直流分量）
  const mean = data.reduce((s, v) => s + v, 0) / fftSize;
  const detrended = data.map((v) => v - mean);

  // FFT
  const { re, im } = fftRadix2(detrended);

  // 计算每个频率的振幅，按强度排序
  const harmonics: { idx: number; amp: number }[] = [];
  for (let k = 1; k < fftSize / 2; k++) {
    const amp = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    harmonics.push({ idx: k, amp });
  }
  harmonics.sort((a, b) => b.amp - a.amp);

  // 取前 numHarmonics 个主导谐波
  const topK = harmonics.slice(0, numHarmonics);
  const harmonicIdxs = new Set(topK.map((h) => h.idx));

  // 重构函数：给定 t（0~fftSize-1 为历史，fftSize~ 为未来）
  const reconstruct = (t: number): number => {
    let val = mean; // 加回均值（直流分量）
    for (let k = 1; k < fftSize / 2; k++) {
      if (!harmonicIdxs.has(k)) continue;
      const angle = (2 * Math.PI * k * t) / fftSize;
      val += (2 * (re[k] * Math.cos(angle) - im[k] * Math.sin(angle))) / fftSize;
    }
    // Nyquist 频率（k = fftSize/2）只有余弦项
    if (harmonicIdxs.has(fftSize / 2)) {
      const k = fftSize / 2;
      val += (re[k] * Math.cos(Math.PI * t)) / fftSize;
    }
    return val;
  };

  // 时间间隔
  const lastTime = klines[n - 1].time;
  const interval = n >= 2 ? klines[n - 1].time - klines[n - 2].time : 3600;
  const dataStartIdx = n - fftSize; // data[0] 对应的 kline index

  // 构建重构值（历史拟合曲线）
  const reconstructed: FourierPoint[] = [];
  for (let t = 0; t < fftSize; t++) {
    const klineIdx = dataStartIdx + t;
    if (klineIdx >= 0 && klineIdx < n) {
      reconstructed.push({
        time: klines[klineIdx].time,
        price: +reconstruct(t).toFixed(4),
      });
    }
  }

  // 构建投影值（未来预测线）
  const projection: FourierPoint[] = [];
  for (let t = fftSize; t < fftSize + projBars; t++) {
    projection.push({
      time: (lastTime + interval * (t - fftSize + 1)) as number,
      price: +reconstruct(t).toFixed(4),
    });
  }

  // 计算 R² 拟合度
  const predicted = data.map((_, t) => reconstruct(t));
  const ssRes = data.reduce((s, v, t) => s + Math.pow(v - predicted[t], 2), 0);
  const ssTot = data.reduce((s, v) => s + Math.pow(v - mean, 2), 0);
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // 主导周期（以K线根数为单位）
  const dominantCycles = topK
    .filter((h) => h.idx > 0)
    .map((h) => Math.round(fftSize / h.idx))
    .filter((c) => c > 0 && c < fftSize);

  return {
    reconstructed,
    projection,
    dominantCycles,
    rSquared,
  };
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

  // 轨道偏移：改用窗口内真正的极值偏差 —— 上轨穿过最高的 high，下轨穿过最低的 low。
  // 修复：此前取 top3 高/低点均值作偏移，偏差被平均后上下轨"悬空"，
  //       不与任何真实 K 线极值相接。现直接以 maxDevUp/maxDevDown 为偏移，
  //       轨道精确锚定窗口内的最高高点和最低低点。
  const upperOffset = maxDevUp;
  const lowerOffset = maxDevDown;

  // 实际的上下轨：平行于回归线，并穿过极值点
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

// ==================== 价值区域（Value Area / Volume Profile） ====================

export interface ValueArea {
  // 分布窗口范围（时间戳）
  windowStart: number;
  windowEnd: number;
  // 实际参与计算的K线数量
  lookback: number;
  // 价值区域上界 / 下界 / 控制点（POC）
  vah: number;
  val: number;
  poc: number;
  // POC 处成交量（最大密度桶）
  pocVolume: number;
  // 窗口总成交量
  totalVolume: number;
  // 价值区目标占比（默认 0.7）
  targetRatio: number;
  // 价格密度剖面：price 为桶中心价，volume 为归一化密度（0~1）
  profile: { price: number; volume: number }[];
  // VAH / VAL 处归一化密度（用于标注支撑/阻力强度）
  vahStrength: number;
  valStrength: number;
}

/**
 * 价值区域（Value Area）计算
 * 市场剖面（Market Profile）概念：
 * 1. 对窗口内每根K线按其价格区间把成交量分配到对应价格桶（按重叠比例拆分）
 * 2. POC（控制点）= 成交量密度最大的价格桶
 * 3. 从 POC 向两侧逐桶扩展，直到累计成交量达到 targetRatio（默认70%）
 *    覆盖区域内价格区间即价值区域：[VAL, VAH]
 */
export function calcValueArea(
  klines: KlineData[],
  lookback: number = 80,
  valueRatio: number = 0.7,
  binCount?: number,
): ValueArea | null {
  const n = klines.length;
  if (n < 20) return null;

  const window = klines.slice(Math.max(0, n - lookback));
  const w = window.length;
  if (w < 15) return null;

  // 全窗口价格范围与总成交量
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  let totalVolume = 0;
  for (const k of window) {
    if (k.low < minPrice) minPrice = k.low;
    if (k.high > maxPrice) maxPrice = k.high;
    totalVolume += k.volume;
  }
  if (minPrice >= maxPrice || totalVolume <= 0) return null;

  // 桶分辨率：默认跟随K线数量调节，保证剖面既平滑又不失细节
  const range = maxPrice - minPrice;
  const bins = binCount ?? Math.max(40, Math.min(160, Math.round(w * 2)));
  const binSize = range / bins;
  if (binSize <= 0) return null;

  // 按价格区间分配成交量（K线与桶重叠比例）
  const volumes = new Array<number>(bins).fill(0);
  for (const k of window) {
    if (k.volume <= 0) continue;
    const startIdx = Math.max(Math.floor((k.low - minPrice) / binSize), 0);
    const endIdxExcl = Math.min(Math.ceil((k.high - minPrice) / binSize), bins);
    if (endIdxExcl <= startIdx) {
      // K线极小，落在桶边界内：就近归入其收盘价所在桶
      const idx = Math.min(Math.max(Math.floor((k.close - minPrice) / binSize), 0), bins - 1);
      volumes[idx] += k.volume;
      continue;
    }
    const kRange = Math.max(k.high - k.low, 1e-9);
    for (let i = startIdx; i < endIdxExcl; i++) {
      const binLow = minPrice + i * binSize;
      const binHigh = binLow + binSize;
      const overlap = Math.max(0, Math.min(k.high, binHigh) - Math.max(k.low, binLow));
      volumes[i] += k.volume * (overlap / kRange);
    }
  }

  // POC：成交量最大桶
  let pocIdx = 0;
  let pocVol = 0;
  for (let i = 0; i < bins; i++) {
    if (volumes[i] > pocVol) {
      pocVol = volumes[i];
      pocIdx = i;
    }
  }
  const poc = minPrice + (pocIdx + 0.5) * binSize;

  // 从 POC 双向扩展至累计成交量达到 targetRatio * 总成交量
  const target = totalVolume * valueRatio;
  let cumulative = volumes[pocIdx];
  let lo = pocIdx;
  let hi = pocIdx;
  while (cumulative < target && (lo > 0 || hi < bins - 1)) {
    const prevVol = lo > 0 ? volumes[lo - 1] : 0;
    const nextVol = hi < bins - 1 ? volumes[hi + 1] : 0;
    if (prevVol >= nextVol) {
      lo--;
      cumulative += prevVol;
    } else {
      hi++;
      cumulative += nextVol;
    }
  }

  const val = minPrice + lo * binSize;
  const vah = minPrice + (hi + 1) * binSize;

  // 归一化密度剖面
  const maxVol = Math.max(...volumes, 1e-9);
  const profile: { price: number; volume: number }[] = [];
  for (let i = 0; i < bins; i++) {
    profile.push({
      price: minPrice + (i + 0.5) * binSize,
      volume: volumes[i] / maxVol,
    });
  }

  return {
    windowStart: window[0].time,
    windowEnd: window[w - 1].time,
    lookback: w,
    poc,
    vah,
    val,
    pocVolume: pocVol,
    totalVolume,
    targetRatio: valueRatio,
    profile,
    vahStrength: hi >= 0 && hi < profile.length ? profile[hi].volume : 0,
    valStrength: lo >= 0 && lo < profile.length ? profile[lo].volume : 0,
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
  // 上警告线 = 上轨 + (上轨 - 该时刻的真实中枢位) = 2*上轨 - 中枢位
  // 修复：此前用 midBC.price（B-C 中点价）作为中枢近似，在时间非等距时
  //       与实际中枢位偏差较大。现用 B/C 各自时刻由 medianSlope 推出的真实中枢位。
  const medianAtB = pointA.price + medianSlope * (pointB.time - pointA.time);
  const medianAtC = pointA.price + medianSlope * (pointC.time - pointA.time);
  const upperWarningStart = { time: pointB.time, price: pointB.price * 2 - medianAtB };
  const upperWarningEnd = { time: endTime, price: upperWarningStart.price + medianSlope * (endTime - pointB.time) };

  const lowerWarningStart = { time: pointC.time, price: pointC.price * 2 - medianAtC };
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
  index: number;      // 原始K线索引
  mergedIndex: number; // 合并后K线索引（笔的间隔判断必须用此坐标，避免坐标系混用）
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
    // 首根方向仅用于应对“(第一、二根即包含)”的情况：按涨跌做一个合理初值，随后无包含即更准
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
      // 按趋势方向合并（方向保持：向上合并取高高，向下合并取低低）
      if (last.direction === 'up') {
        last.high = Math.max(last.high, curr.high);
        last.low = Math.max(last.low, curr.low);
      } else {
        last.high = Math.min(last.high, curr.high);
        last.low = Math.min(last.low, curr.low);
      }
      last.volume += curr.volume;
    } else {
      // 无包含，新增：方向由“当前K线相对上一根合并K线的高低点”决定（无包含时非升即降）
      const newDir: 'up' | 'down' = curr.high > last.high ? 'up' : 'down';
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
      // 与上一分型在合并K线上至少间隔 2 根（避免紧邻伪分型）
      const last = fractals[fractals.length - 1];
      if (!last || i - last.mergedIndex >= 2) {
        fractals.push({ index: curr.index, mergedIndex: i, time: curr.time, price: curr.high, type: 'top' });
      }
    }
    // 底分型：低点最低 + 高点也最低
    if (curr.low < prev.low && curr.low < next.low &&
        curr.high < prev.high && curr.high < next.high) {
      const last = fractals[fractals.length - 1];
      if (!last || i - last.mergedIndex >= 2) {
        fractals.push({ index: curr.index, mergedIndex: i, time: curr.time, price: curr.low, type: 'bottom' });
      }
    }
  }
  return fractals;
}

// 笔：连接相邻的顶底分型。
// 标准要求：顶底分型之间在【合并K线】上至少间隔 4 根；中间不能有同向更优分型。
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
      // 间隔至少4根合并K线（用 mergedIndex，避免与原始K线坐标系混用）
      if (candidate.mergedIndex - start.mergedIndex < 4) continue;
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

  // 相邻两个中枢不允许在时间上重叠：新中枢必须完全在最近一个中枢结束之后才开始。
  // 否则滑动扫描会生成大量时间重叠、进而产生重复买卖点信号的重复中枢。
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
    if (overlapLow >= overlapHigh) continue; // 三笔无重叠区间，不成中枢

    const last = zhongshus[zhongshus.length - 1];
    if (last && b1.startTime <= last.endTime) {
      // 窗口仍落在最近中枢的时间跨度内：优先尝试延伸（允许持续吸收后续笔）
      const newHigh = Math.min(last.high, overlapHigh);
      const newLow = Math.max(last.low, overlapLow);
      if (newHigh > newLow) {
        // 边界仍有效，延伸中枢
        last.endTime = b3.endTime;
        last.high = newHigh;
        last.low = newLow;
        last.biCount += 1;
        // 延伸判断：超过6笔标记延伸；超过9笔级别+1
        last.isExtended = last.biCount >= 6;
        if (last.biCount >= 9) last.level = 2;
      }
      // 边界交叉则中枢结构被破坏，跳过该窗口，等窗口完全离开后再开新中枢
      continue;
    }
    // 窗口已完全在最近中枢结束之后 → 开新中枢（不与旧中枢时间重叠）
    zhongshus.push({
      startTime: b1.startTime, endTime: b3.endTime,
      high: overlapHigh, low: overlapLow, biCount: 3, level: 1, isExtended: false,
    });
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
  macdHist: (number | null)[] | null = null,
): ChanSignal[] {
  const signals: ChanSignal[] = [];
  if (zhongshus.length === 0 || bis.length === 0 || klines.length === 0) return signals;

  // 遍历每个中枢，检测各自的买卖点
  // 记录上一段“同方向离开段”，用于背驰两段比较（一买/一卖）
  const lastSameDirSeg: Record<string, { startIdx: number; endIdx: number; range: number; time: number } | undefined> = {};

  for (let zi = 0; zi < zhongshus.length; zi++) {
    const zs = zhongshus[zi];

    // 依时间序收集本中枢结束之后的所有笔（离开段与回抽均取自这些笔）
    const after: ChanBi[] = [];
    for (const b of bis) if (b.startTime > zs.endTime) after.push(b);

    // ---- 三类买卖点：离开 + 回抽确认 ----
    // 标准：向上离开中枢（离开笔高点>上沿），随之回抽一笔向下且其低点不破上沿 → 三买（取回抽低点）；
    //       向下离开（离开笔低点<下沿），回抽一笔向上且其高点不破下沿 → 三卖（取回抽高点）。
    for (let bi = 0; bi < after.length - 1; bi++) {
      const leave = after[bi];
      const pull = after[bi + 1];
      const leaveHigh = Math.max(leave.startPrice, leave.endPrice);
      const leaveLow = Math.min(leave.startPrice, leave.endPrice);
      if (leave.direction === 'up' && leaveHigh > zs.high) {
        // 向上离开后，回抽笔必须是向下，且回抽低点不回中枢上沿
        if (pull.direction === 'down') {
          const pullLow = Math.min(pull.startPrice, pull.endPrice);
          if (pullLow > zs.high) {
            signals.push({
              type: 'thirdBuy', price: pullLow, time: pull.endTime,
              description: `三买：${zi + 1}#中枢向上离开后回抽不破上沿`,
            });
            break; // 每个中枢只标第一个三买
          }
        }
      } else if (leave.direction === 'down' && leaveLow < zs.low) {
        // 向下离开后，回抽笔必须是向上，且回抽高点不回中枢下沿
        if (pull.direction === 'up') {
          const pullHigh = Math.max(pull.startPrice, pull.endPrice);
          if (pullHigh < zs.low) {
            signals.push({
              type: 'thirdSell', price: pullHigh, time: pull.endTime,
              description: `三卖：${zi + 1}#中枢向下离开后回抽不破下沿`,
            });
            break;
          }
        }
      }
    }

    // ---- 背驰判断（一买/一卖）：对比本中枢离开段与上一段同方向离开段的动能 ----
    // 将本中枢后连续同向的笔合并为一个离开段，与更早的同方向离开段比较：
    // MACD 柱面积衰减为第一判据，价格幅度收窄为第二判据。
    // 相比原实现，不再把一、二类买卖点锁死在最后一根K线，而是随每个中枢逐段确认。
    if (after.length > 0) {
      const leave0 = after[0];
      const dir = leave0.direction;
      let leaveStartIdx = leave0.startIndex;
      let leaveEndIdx = leave0.endIndex;
      let k = 1;
      while (k < after.length && after[k].direction === dir) { leaveEndIdx = after[k].endIndex; k++; }
      const leaveStartP = leave0.startPrice;
      const leaveEndP = after[k - 1].endPrice;
      const leaveRange = Math.abs(leaveEndP - leaveStartP);
      const leaveTime = after[k - 1].endTime;

      const prevSeg = lastSameDirSeg[dir];
      if (prevSeg) {
        let macdDiverge: boolean | null = null;
        if (macdHist) {
          const aPrev = chanBiMacdArea(macdHist, prevSeg.startIdx, prevSeg.endIdx);
          const aLast = chanBiMacdArea(macdHist, leaveStartIdx, leaveEndIdx);
          // 面积需同号且非零（up 段>0、down 段<0）才启用面积判据；
          // 落入 MACD 预热区(面积为0)时退回价格幅度。
          const sameSign = dir === 'up' ? (aPrev > 0 && aLast > 0) : (aPrev < 0 && aLast < 0);
          if (aPrev !== 0 && aLast !== 0 && sameSign)
            macdDiverge = Math.abs(aLast) < Math.abs(aPrev) * 0.8;
          else macdDiverge = null;
        }
        const diverge = macdDiverge !== null ? macdDiverge : leaveRange < prevSeg.range * 0.8;
        if (diverge) {
          const isBuy = dir === 'down';
          signals.push({
            type: isBuy ? 'firstBuy' : 'firstSell',
            price: leaveEndP, time: leaveTime,
            description: `${isBuy ? '一买' : '一卖'}：${zi + 1}#中枢离开段 ${macdDiverge !== null ? 'MACD 面积背驰' : '价格幅度背驰'}`,
          });
        }
      }
      lastSameDirSeg[dir] = { startIdx: leaveStartIdx, endIdx: leaveEndIdx, range: leaveRange, time: leaveTime };
    }

    // ---- 二类买卖点：离开段后的第一次回试未回到中枢边界（次级别确认） ----
    // 用「中枢结束后的第一笔」作为回试笔：回试笔向下且其低点不破下沿 → 二买；
    // 回试笔向上且其高点不破上沿 → 二卖。不再取整段末尾最后一笔，避免重复信号。
    if (after.length > 0) {
      const retest = after[0];
      const low = Math.min(retest.startPrice, retest.endPrice);
      const high = Math.max(retest.startPrice, retest.endPrice);
      if (retest.direction === 'down' && low > zs.low) {
        signals.push({
          type: 'secondBuy', price: retest.endPrice, time: retest.endTime,
          description: `二买：${zi + 1}#中枢离开后回试未破下沿`,
        });
      } else if (retest.direction === 'up' && high < zs.high) {
        signals.push({
          type: 'secondSell', price: retest.endPrice, time: retest.endTime,
          description: `二卖：${zi + 1}#中枢离开后回试未破上沿`,
        });
      }
    }
  }

  return signals;
}

// 计算某笔（按起止 index 在原始K线上的位置）对应的 MACD 柱(hist)面积
// 用于缠论标准背驰判定：对比同级别前后两段同向笔的动能，而非单纯价格幅度。
// hist 即 calcMACD 输出的柱状图数组（12/26/9），向上笔面积应>0，向下笔面积应<0。
function chanBiMacdArea(hist: (number | null)[], startIndex: number, endIndex: number): number {
  let area = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    const h = hist[i];
    if (h === undefined || h === null) continue;
    area += h;
  }
  return area;
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
  // 计算 MACD 柱面积用于标准背驰判定（12/26/9）
  let macdHist: (number | null)[] | null = null;
  const macdData = calcMACD(klines, 12, 26, 9);
  if (macdData && macdData.hist) macdHist = macdData.hist;
  const signals = detectChanSignals(bis, zhongshus, klines, macdHist);
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

/** AB 波段最小幅度门槛（%，A/B 点检测与 AB9、斐波那契共用，消除多处魔数漂移） */
const AB_MIN_SWING_PCT = 2;

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
 * 注：最近 strength 根K线无法确认为分形（右侧K线数不足），属分形确认机制的固有滞后；
 * 已在函数尾部对"未确认运行极值"做投影补齐（仅在创新高/新低时追加），缓解该滞后。
 */
/** 插针判定阈值：单侧影线占「影线+实体」的比例，超过视为插针，帧价取实体极点而非毛刺极值 */
const SPIKE_WICK_RATIO = 0.7;

/**
 * 帧点价的影线过滤：上/下影线占比过高（插针）时，用实体端点替代毛刺极值，
 * 避免长影线把 A/B 顶/底拉偏、导致整组 9 线（斐波）偏移。
 * 仅修正价格量级，不影响"是否为分形"的判定（相邻比较仍用原始 high/low）。
 */
function fractalPrice(k: KlineData, dir: 'high' | 'low'): number {
  const bodyHigh = Math.max(k.open, k.close);
  const bodyLow = Math.min(k.open, k.close);
  const body = bodyHigh - bodyLow;
  if (dir === 'high') {
    const wick = Math.max(0, k.high - bodyHigh);
    const total = wick + body;
    return total > 0 && wick / total > SPIKE_WICK_RATIO ? bodyHigh : k.high;
  }
  const wick = Math.max(0, bodyLow - k.low);
  const total = wick + body;
  return total > 0 && wick / total > SPIKE_WICK_RATIO ? bodyLow : k.low;
}

export function detectFractals(klines: KlineData[], strength = 3): {
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
    if (isHigh) fractalHighs.push({ idx: i, price: fractalPrice(klines[i], 'high') });
    if (isLow) fractalLows.push({ idx: i, price: fractalPrice(klines[i], 'low') });
  }

  // —— 尾部未确认区补齐（缓解最近 strength 根无法确认为分形的固有滞后）——
  // 仅当"尾部运行极值"确实突破已确认的同向极值时，才投影为待确认分形，
  // 使现价在创新高 / 创新低时 A/B 能跟上最新极值，而非停在上一轮结构。
  // 行情回落或震荡时不会新增点（未突破已确认极值），故不会引入收缩/抖动。
  const tailStart = klines.length - strength;
  if (tailStart > strength) {
    let runHigh = -Infinity; let runHighIdx = -1;
    let runLow = Infinity; let runLowIdx = -1;
    for (let i = tailStart; i < klines.length; i++) {
      const h = fractalPrice(klines[i], 'high');
      if (h > runHigh) { runHigh = h; runHighIdx = i; }
      const l = fractalPrice(klines[i], 'low');
      if (l < runLow) { runLow = l; runLowIdx = i; }
    }
    const maxConfirmed =
      fractalHighs.length > 0 ? Math.max(...fractalHighs.map((f) => f.price)) : -Infinity;
    const minConfirmed =
      fractalLows.length > 0 ? Math.min(...fractalLows.map((f) => f.price)) : Infinity;
    if (runHighIdx >= 0 && runHigh > maxConfirmed) fractalHighs.push({ idx: runHighIdx, price: runHigh });
    if (runLowIdx >= 0 && runLow < minConfirmed) fractalLows.push({ idx: runLowIdx, price: runLow });
  }

  return { fractalHighs, fractalLows };
}

/** 由分形点构建候选波段：低点在前高点在后为上升，反之下降；幅度不足 minPct% 的忽略 */
function buildSwings(
  fractalHighs: { idx: number; price: number }[],
  fractalLows: { idx: number; price: number }[],
  minPct = AB_MIN_SWING_PCT,
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
    // 含边界：当前价落在波段端点（=分形极值）时同样命中，避免 A/B 点无谓跳变
    return currentPrice >= lo && currentPrice <= hi;
  });
  if (containing.length > 0) {
    // 线性扫描取幅度最大者，省去排序与数组拷贝
    return containing.reduce((a, b) => (b.range > a.range ? b : a));
  }

  // 2. 向上突破：在所有被向上突破的上升波段中，取终点（高点）最高、幅度最大者
  const brokenUp = swings.filter(
    (s) => s.direction === 'up' && currentPrice > Math.max(s.startPrice, s.endPrice),
  );
  if (brokenUp.length > 0) {
    return brokenUp.reduce((a, b) => (b.endPrice > a.endPrice || (b.endPrice === a.endPrice && b.range > a.range) ? b : a));
  }

  // 3. 向下跌破：在所有被向下跌破的下降波段中，取终点（低点）最低、幅度最大者
  const brokenDown = swings.filter(
    (s) => s.direction === 'down' && currentPrice < Math.min(s.startPrice, s.endPrice),
  );
  if (brokenDown.length > 0) {
    return brokenDown.reduce((a, b) => (b.endPrice < a.endPrice || (b.endPrice === a.endPrice && b.range > a.range) ? b : a));
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
        const h = fractalPrice(klines[i], 'high');
        if (h > runHigh) { runHigh = h; runHighIdx = i; }
      }
      if (runHigh > anchor.price && ((runHigh - anchor.price) / anchor.price) * 100 >= AB_MIN_SWING_PCT) {
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
        const l = fractalPrice(klines[i], 'low');
        if (l < runLow) { runLow = l; runLowIdx = i; }
      }
      if (anchor.price > runLow && ((anchor.price - runLow) / anchor.price) * 100 >= AB_MIN_SWING_PCT) {
        return { startPrice: anchor.price, endPrice: runLow, startIdx: anchor.idx, endIdx: runLowIdx, direction: 'down', range: anchor.price - runLow };
      }
    }
  }

  // 6. 兜底：最近完成的波段（endIdx 最大，幅度大者优先）
  if (swings.length === 0) return null;
  return swings.reduce((a, b) => (b.endIdx > a.endIdx || (b.endIdx === a.endIdx && b.range > a.range) ? b : a));
}

/** AB 波段点检测结果：分形点 + 选定波段 */
interface ResolvedAB {
  fractalHighs: { idx: number; price: number }[];
  fractalLows: { idx: number; price: number }[];
  selected: SwingCandidate;
}

/**
 * 一次完成 AB 点检测（分形 → 候选 → 选定），并按“尾部内容签名”做缓存。
 * AB9 与斐波那契共用同一组 A/B 点，避免每条 K 线重复跑 O(n²) 波段筛选。
 *
 * 注意：不能用数组引用做缓存 key——实时路径会原地改写同一数组（push / 改 last，不换引用），
 * 引用级缓存会让 AB9/斐波那契/江恩画线在整个会话内冻结在首载值，直到切币种/周期。
 * 改为按 length + 最后一根 time/close 生成内容签名，且仅缓存最近一条（Map 始终 O(1)）。
 */
const abPointCache = new Map<string, ResolvedAB>();

function resolveABPoints(klines: KlineData[]): ResolvedAB | null {
  const last = klines[klines.length - 1];
  const sig = `${klines.length}:${last.time}:${last.close}`;
  const cached = abPointCache.get(sig);
  if (cached) return cached;

  // 仅当两侧分形全为空才放弃：单边行情下一侧分形为空是常态，
  // 交给 selectSwing 的单边兜底分支处理（此前用 || 会提前拦截 → 画线消失）
  const { fractalHighs, fractalLows } = detectFractals(klines);
  if (fractalHighs.length === 0 && fractalLows.length === 0) return null;

  // 候选波段为空不提前返回 —— 纯单边行情可能凑不出任何满足幅度阈值的
  // 完整波段，此时由 selectSwing 的兜底分支直接以「分形锚点 → 运行极值」构造
  const allSwings = buildSwings(fractalHighs, fractalLows);
  const currentPrice = klines[klines.length - 1].close;
  const selected = selectSwing(klines, allSwings, fractalHighs, fractalLows, currentPrice);
  if (!selected) return null;

  const result: ResolvedAB = { fractalHighs, fractalLows, selected };
  abPointCache.clear(); // 仅保留最近一条，防 Map 无限增长
  abPointCache.set(sig, result);
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

  // 1. AB 点检测（与 AB9线 共享同一套逻辑 + 引用级缓存，两套画线始终锚定同一组 A/B 点）
  const resolved = resolveABPoints(klines);
  if (!resolved) return null;
  const selected = resolved.selected;

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
  /** 近距离穿越事件：当前价相对上一根K线发生的关键线穿越（供信号触发） */
  cross: AB9Cross[];
  /** 波段斜率（价格/根）与量能比，辅助强度判断 */
  slope: number;
  /** 量能支撑：当前 vs AB段平均成交量，>1 表示放量 */
  volumeRatio: number;
  /** 当前价上方最近的内部线号（阻力参考）。null=上方无内部线或处于扩展区 */
  refLineResistance: number | null;
  /** 当前价下方最近的内部线号（支撑参考）。null=下方无内部线或处于扩展区 */
  refLineSupport: number | null;
}

/** AB9 关键线穿越事件 */
export interface AB9Cross {
  /** 触发方向：'up'=向上穿越(升破) 'down'=向下穿越(跌破) */
  dir: 'up' | 'down';
  /** 被穿越的线号 1-9 */
  lineNo: number;
  /** 触发时的上一根K线价与当前价 */
  from: number;
  to: number;
  /** 语义标签：中轴/趋势破坏/突破等高价值参考 */
  label: string;
  time: number;
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

  // 1. AB 点检测（与斐波那契共享同一套逻辑 + 引用级缓存，两套画线锚定同一组 A/B 点）
  const resolved = resolveABPoints(klines);
  if (!resolved) return null;
  const selected = resolved.selected;

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
  // 相对 A/B 高 0.8% 与绝对价 0.1% 取较大，避免低价品种/极小波段上测不到邻近线
  const threshold = Math.max(height * 0.008, currentPrice * 0.001);
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

  // 计算AB段长度与斜率（价格/根）
  const swingLen = Math.max(1, selected.endIdx - selected.startIdx);
  const slope = height / swingLen;

  // 量能比：当前(最近5根)均量 vs AB段均量
  const volArr = klines.filter((k) => typeof k.volume === 'number');
  let volumeRatio = 1;
  if (volArr.length >= 6) {
    const recent = volArr.slice(-5);
    const recentAvg = recent.reduce((s, k) => s + k.volume, 0) / recent.length;
    const abVols = volArr.slice(selected.startIdx, selected.endIdx + 1);
    if (abVols.length > 0) {
      const abAvg = abVols.reduce((s, k) => s + k.volume, 0) / abVols.length;
      if (abAvg > 0) volumeRatio = recentAvg / abAvg;
    }
  }

  // 跨线事件：用上一根已收盘K线价比较当前价相对各线的位置
  const cross: AB9Cross[] = [];
  if (klines.length >= 2) {
    const prevClose = klines[klines.length - 2].close;
    const prevTime = klines[klines.length - 2].time;
    for (const line of lines) {
      const wasAbove = prevClose >= line.price;
      const isAbove = currentPrice >= line.price;
      if (wasAbove !== isAbove) {
        const dir: 'up' | 'down' = isAbove ? 'up' : 'down';
        let label: string;
        if (line.lineNo === 4) label = '中轴';
        else if (line.lineNo <= 3) label = '趋势破坏区';
        else if (line.lineNo >= 8) label = '突破/扩展区';
        else label = `${line.lineNo}线`;
        cross.push({ dir, lineNo: line.lineNo, from: prevClose, to: currentPrice, label, time: prevTime });
      }
    }
  }

  // 支撑/阻力参考：按当前价上下分段取最近的内部线（排除9线扩展位，作为风控参考更稳妥的参数）
  let refLineResistance: number | null = null;
  let refLineSupport: number | null = null;
  let bestR = Infinity, bestS = Infinity;
  for (const line of lines) {
    if (line.lineNo === 9) continue; // 扩展位一般不止损参考
    if (line.price >= currentPrice) {
      const gap = line.price - currentPrice;
      if (gap < bestR) { bestR = gap; refLineResistance = line.lineNo; }
    } else {
      const gap = currentPrice - line.price;
      if (gap < bestS) { bestS = gap; refLineSupport = line.lineNo; }
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
    cross,
    slope,
    volumeRatio,
    refLineSupport,
    refLineResistance,
  };
}

/**
 * 震荡箱体 / 近端支撑阻力：检测价格是否处于箱体区间，并给出支撑区下沿与阻力区上沿。
 * 独立于策略引擎，供主图画箱体（区间）或近端支撑/阻力参考线。
 */
export interface RangeBox {
  /** 箱体下沿（支撑区） */
  support: number;
  /** 箱体上沿（阻力区） */
  resistance: number;
  /** 是否判定为箱体（价格仍在区间内、宽度适中、有多点触及） */
  isRange: boolean;
  /** 箱体宽度百分比（相对中线） */
  widthPct: number;
  /** 箱体上下沿被触及的总次数 */
  touches: number;
  /** 当前价在箱体内的位置 */
  position: 'near-support' | 'near-resistance' | 'middle';
}
export function calcRangeBox(klines: KlineData[], lookback = 20): RangeBox | null {
  const n = klines.length;
  if (n < 8) return null;
  const last = klines[n - 1];
  const win = klines.slice(Math.max(0, n - lookback), n);
  const swHigh: number[] = [], swLow: number[] = [];
  for (let i = 1; i < win.length - 1; i++) {
    const a = win[i - 1], c = win[i], b = win[i + 1];
    if (c.high >= a.high && c.high >= b.high) swHigh.push(c.high);
    if (c.low <= a.low && c.low <= b.low) swLow.push(c.low);
  }
  if (swHigh.length < 2 || swLow.length < 2) return null;
  swHigh.sort((x, y) => x - y);
  swLow.sort((x, y) => x - y);
  // 箱体上下沿：取高低点群的稳健代表（排除单一极端 spike）
  const hiHi = swHigh[Math.min(swHigh.length - 1, Math.floor(swHigh.length * 0.85))];
  const loLo = swLow[Math.min(swLow.length - 1, Math.floor(swLow.length * 0.15))];
  const resistance = hiHi > last.close ? hiHi : (swHigh[swHigh.length - 1] || hiHi);
  const support = loLo < last.close ? loLo : (swLow[0] || loLo);
  if (support >= resistance) return null;
  const mid = (support + resistance) / 2;
  const widthPct = (resistance - support) / Math.max(1e-9, mid) * 100;
  const inside = last.close >= support && last.close <= resistance;
  // 触及次数：价格接近上/下沿的K线数（±1.2% 判为一次触及）
  let touches = 0;
  for (const k of win) {
    if (Math.abs(k.high - resistance) / resistance <= 0.012) touches++;
    if (Math.abs(k.low - support) / support <= 0.012) touches++;
  }
  const isRange = inside && widthPct >= 0.8 && widthPct <= 12 && touches >= 2;
  const pos = (resistance - support) > 0 ? (last.close - support) / (resistance - support) : 0.5;
  const position = pos < 0.35 ? 'near-support' : pos > 0.65 ? 'near-resistance' : 'middle';
  return { support, resistance, isRange, widthPct, touches, position };
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

// ========== 常驻多空方向信号（结构顺趋势为主） ==========
// ========== 江恩工具箱（角度线 / 时间周期 / 时价四方 / 轮中轮 / 三分位）==========
// 全部复用 AB9 的同一组 A/B 波段（resolveABPoints），价格轴各工具与 AB9、
// 斐波那契锚定完全一致。lib 只产出几何量，像素化由图表层完成。

export interface GannFanRay { label: string; ratio: number; }

/** 江恩角度线（Gann Fan）：以波段起点为锚，1x1 = 单位价/单位时，45° 主角度 */
export interface GannFan {
  /** 锚点下标/时间/价格（上升=波段低点，下降=波段高点） */
  anchorIdx: number; anchorTime: number; anchorPrice: number;
  direction: 'up' | 'down';
  /** 波段时长（根） */
  spanBars: number;
  /** 单根K线时间间隔（秒，供图表层外推时间→x） */
  interval: number;
  /** 1x1 价格步长（每根），= 波段幅度 / 波段时长 */
  unitPerBar: number;
  rays: GannFanRay[];
}

/**
 * 江恩角度线：以当前 A/B 波段的"平均每根涨幅"作为 1x1 单位，
 * 生成 8x1..1x16 一组角度射线（上升趋势从低点向上发散，下降趋势从高点向下发散）。
 */
export function calcGannFan(klines: KlineData[]): GannFan | null {
  const ab = resolveABPoints(klines);
  if (!ab) return null;
  const s = ab.selected;
  const spanBars = Math.max(1, s.endIdx - s.startIdx);
  const unitPerBar = s.range / spanBars;
  if (!(unitPerBar > 0)) return null;
  const interval = klines.length > 1 ? klines[1].time - klines[0].time : 0;
  const rays: GannFanRay[] = [
    { label: '8x1', ratio: 8 }, { label: '4x1', ratio: 4 }, { label: '2x1', ratio: 2 },
    { label: '1x1', ratio: 1 }, { label: '1x2', ratio: 0.5 }, { label: '1x4', ratio: 0.25 },
    { label: '1x8', ratio: 0.125 }, { label: '1x16', ratio: 0.0625 },
  ];
  return {
    anchorIdx: s.startIdx, anchorTime: klines[s.startIdx].time, anchorPrice: s.startPrice,
    direction: s.direction, spanBars, interval, unitPerBar, rays,
  };
}

export interface GannTimeCycle { bars: number; label: string; time: number; price: number; }
export interface GannTimeCycles {
  /** 单根K线的时间间隔（秒） */
  interval: number;
  pivots: { idx: number; time: number; price: number; label: string }[];
  /** 各周期节点（含未来时间，由图表层外推 x） */
  markers: GannTimeCycle[];
}

/**
 * 江恩时间周期：从当前波段的两个端点起，向右外推 45/90/144/180/270/360 根
 * 的时间对称转折点。时段落在未来，图表层用最后两根K线间距外推 x。
 */
export function calcGannTimeCycles(klines: KlineData[]): GannTimeCycles | null {
  const ab = resolveABPoints(klines);
  if (!ab || klines.length < 2) return null;
  const interval = klines[1].time - klines[0].time;
  if (!(interval > 0)) return null;
  const s = ab.selected;
  const pivots = [
    { idx: s.startIdx, time: klines[s.startIdx].time, price: s.startPrice, label: s.direction === 'up' ? '低点' : '高点' },
    { idx: s.endIdx, time: klines[s.endIdx].time, price: s.endPrice, label: s.direction === 'up' ? '高点' : '低点' },
  ];
  const cycles = [45, 90, 144, 180, 270, 360];
  const markers: GannTimeCycle[] = [];
  for (const p of pivots) {
    for (const bars of cycles) {
      markers.push({ bars, label: `${p.label}+${bars}`, time: p.time + bars * interval, price: p.price });
    }
  }
  markers.sort((a, b) => a.time - b.time);
  return { interval, pivots, markers };
}

/** 江恩时价四方：以当前波段为盒，对角线与 1x1 主角度线重合 */
export interface GannSquare {
  startIdx: number; endTime: number;
  /** 盒子时间跨度（根，等分价轴时的一格） */
  bars: number;
  priceLo: number; priceHi: number;
  /** 1x1 价格步长 */
  step: number;
  interval: number;
}

export function calcGannSquare(klines: KlineData[]): GannSquare | null {
  const ab = resolveABPoints(klines);
  if (!ab || klines.length < 2) return null;
  const s = ab.selected;
  if (!(s.range > 0)) return null;
  const interval = klines[1].time - klines[0].time;
  if (!(interval > 0)) return null;
  const xSpan = Math.max(1, s.endIdx - s.startIdx);
  const step = s.range / xSpan; // 每根价格步长 = 1x1 斜率
  const priceLo = Math.min(s.startPrice, s.endPrice);
  const priceHi = Math.max(s.startPrice, s.endPrice);
  return {
    startIdx: s.startIdx, bars: xSpan, priceLo, priceHi, step, interval,
    endTime: klines[s.startIdx].time + xSpan * interval,
  };
}

export interface GannNineLevel { deg: number; price: number; }
export interface GannSquareOfNine {
  seed: number; seedLabel: string; seedIndex: number; seedTime: number;
  direction: 'up' | 'down';
  /** 上方档位 */
  resistance: GannNineLevel[];
  /** 下方档位 */
  support: GannNineLevel[];
}

/** 轮中轮（江恩九宫格）：√N 旋转法推支撑/阻力，步进 45°~360° */
function sqrtRot(v: number, delta: number): number {
  const s = Math.sqrt(Math.max(v, 1e-12));
  return (s + delta) * (s + delta);
}

export function calcGannSquareOfNine(klines: KlineData[]): GannSquareOfNine | null {
  const ab = resolveABPoints(klines);
  if (!ab) return null;
  const s = ab.selected;
  const seed = s.direction === 'up' ? s.endPrice : s.startPrice;
  const seedIndex = s.direction === 'up' ? s.endIdx : s.startIdx;
  const steps = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const resistance: GannNineLevel[] = [];
  const support: GannNineLevel[] = [];
  const push = (arr: GannNineLevel[], sign: number) => {
    for (const d of steps) {
      const price = sqrtRot(seed, sign * d);
      if (price > 0) arr.push({ deg: Math.round(d * 360), price });
    }
  };
  if (s.direction === 'up') {
    push(support, -1); // 种子为高点，向下推支撑
    push(resistance, 1);
  } else {
    push(resistance, 1); // 种子为低点，向上推阻力
    push(support, -1);
  }
  // 就近过滤：≤0 已排除；同一侧内排序
  resistance.sort((a, b) => a.price - b.price);
  support.sort((a, b) => b.price - a.price);
  return {
    seed, seedLabel: s.direction === 'up' ? '波段高点' : '波段低点',
    seedIndex, seedTime: klines[seedIndex].time, direction: s.direction,
    resistance, support,
  };
}

export interface GannThirdLevel { ratio: number; label: string; price: number; }

/** 江恩三分位：1/3、2/3（百分比轴与八分并行的三分补充） */
export function calcGannThirds(klines: KlineData[]): GannThirdLevel[] | null {
  const ab = resolveABPoints(klines);
  if (!ab) return null;
  const s = ab.selected;
  const H = s.range;
  const lo = s.startPrice, hi = s.endPrice;
  const val = (r: number): number => (s.direction === 'up' ? lo + H * r : hi - H * r);
  return [
    { ratio: 1 / 3, label: '1/3', price: val(1 / 3) },
    { ratio: 2 / 3, label: '2/3', price: val(2 / 3) },
  ];
}

export interface GannBundle {
  fan: GannFan | null;
  timeCycles: GannTimeCycles | null;
  square: GannSquare | null;
  squareOfNine: GannSquareOfNine | null;
  thirds: GannThirdLevel[] | null;
}

export function calcGannAll(klines: KlineData[]): GannBundle {
  if (!klines || klines.length < 30) {
    return { fan: null, timeCycles: null, square: null, squareOfNine: null, thirds: null };
  }
  return {
    fan: calcGannFan(klines),
    timeCycles: calcGannTimeCycles(klines),
    square: calcGannSquare(klines),
    squareOfNine: calcGannSquareOfNine(klines),
    thirds: calcGannThirds(klines),
  };
}

// 以道氏结构定大方向，缠论最近笔方向做共振确认，AB9 下降趋势破坏做否决。
// 用途：给用户一个明确的「现在做多 / 做空 / 观望」执行参考（决策辅助，非带单）。
// 回测结论(真实行情, 不含交易成本, 触发带宽0.5×ATR, 窗口12根)：
//   ETH 4h：多头≈48% / 空头≈46%   ETH 1h：多头≈52% / 空头≈51%
//   BTC 4h：多头≈44% / 空头≈37%（系统无效，勿用于BTC）
export type DirectionDecision = 'long' | 'short' | 'neutral';

export interface DirectionSignal {
  /** 常驻方向结论 */
  decision: DirectionDecision;
  /** 用户可读标签：做多 / 做空 / 观望 */
  label: string;
  /** 综合置信度 0-100（反映依据充分度，非承诺胜率） */
  confidence: number;
  /** 依据简述（各子依据来源，绝不虚构读数） */
  basis: string;
  /** 结构方向标签（强多头/偏多/震荡...） */
  trendLabel: string;
  /** 缠论最近笔方向：'up'|'down'|null */
  biDir: 'up' | 'down' | null;
  /** AB9 强/弱评级 */
  ab9Strength: string | null;
  /** 当前价就近的 AB9 支撑/阻力参考线号 */
  refLine: number | null;
  /** 建议入场参考价（当前收盘） */
  entry: number;
  /** 窄止损位（AB9 就近内部线，过低时以 0.3×ATR 兜底，绝不虚构） */
  stop: number | null;
  /** 顺势目标位（下一档 AB9 线，尽力保证盈亏比≥1；区间外可能无目标） */
  target: number | null;
  /** 盈亏比 ≈ |target-entry| / |entry-stop|，>0 越高越划算；null=区间外无目标 */
  rewardRisk: number | null;
}

export function calcDirectionSignal(klines: KlineData[]): DirectionSignal | null {
  if (!klines || klines.length < 60) return null;

  const trend = calcTrendSignal(klines);
  const ab9 = calcAB9Lines(klines);
  const chan = calcChan(klines);

  let decision: DirectionDecision = 'neutral';
  let confidence = 40;
  const reasons: string[] = [];

  // 1) 结构方向为主
  if (trend) {
    if (trend.direction === 'bullish') {
      decision = 'long';
      confidence += trend.strength === 'strong' ? 22 : 10;
      reasons.push(`结构${trend.label}`);
    } else if (trend.direction === 'bearish') {
      decision = 'short';
      confidence += trend.strength === 'strong' ? 18 : 7;
      reasons.push(`结构${trend.label}`);
    } else {
      reasons.push('结构震荡');
    }
  } else {
    reasons.push('结构数据不足');
  }

  const trendFlowsWith = (biDir: 'up' | 'down') =>
    (decision === 'long' && biDir === 'up') || (decision === 'short' && biDir === 'down');

  // 2) 缠论最近笔方向共振/否决
  let biDir: 'up' | 'down' | null = null;
  if (chan && chan.bis.length) {
    const lastBi = chan.bis[chan.bis.length - 1];
    biDir = lastBi.direction;
    if (decision === 'neutral') {
      // 结构震荡时，缠论笔方向作为兜底倾向（弱信号，不抬高置信太高）
      decision = biDir === 'up' ? 'long' : 'short';
      confidence = 42;
      reasons.push(biDir === 'up' ? '缠论笔向上兜底' : '缠论笔向下兜底');
    } else if (trendFlowsWith(biDir)) {
      confidence += 10;
      reasons.push('缠论笔顺向');
    } else {
      // 结构已定方向但最近笔反向：本级别回调进行中，观望等企稳
      decision = 'neutral';
      confidence = 40;
      reasons.push('缠论笔反向，回调中');
    }
  }

  // 3) AB9 强度顺向加分 / 破坏否决
  let ab9Strength: string | null = null;
  if (ab9) {
    const ab9Dir = ab9.direction === 'up' ? 'up' : 'down';
    ab9Strength = ab9.strength;
    if (decision !== 'neutral' && !trendFlowsWith(ab9Dir) && ab9.strength === '趋势破坏') {
      decision = 'neutral';
      confidence = 35;
      reasons.push('AB9结构破坏');
    } else if (decision !== 'neutral' && trendFlowsWith(ab9Dir) && ab9.strength === '较强趋势') {
      confidence += 8;
      reasons.push('AB9较强顺势');
    }
  }

  const label = decision === 'long' ? '做多' : decision === 'short' ? '做空' : '观望';
  if (decision === 'neutral') confidence = Math.min(confidence, 45);
  confidence = Math.max(15, Math.min(90, Math.round(confidence)));

  // 盈亏比优先：用 AB9 内部线给出窄止损 + 顺势目标（真实几何，绝不虚构）
  const entry = klines[klines.length - 1].close;
  const atrArr = calcATRArray(klines, 14);
  const atr = atrArr.length ? (atrArr[atrArr.length - 1] || 0) : 0;
  let stop: number | null = null;
  let target: number | null = null;
  if (ab9 && ab9.lines.length && decision !== 'neutral') {
    const upLines = ab9.lines.filter((ln) => ln.price > entry).sort((a, b) => a.price - b.price);
    const dnLines = ab9.lines.filter((ln) => ln.price < entry).sort((a, b) => b.price - a.price);
    if (decision === 'long') {
      target = upLines.length ? upLines[0].price : null;
      stop = dnLines.length ? dnLines[0].price : (atr ? entry - 1.2 * atr : null);
    } else {
      target = dnLines.length ? dnLines[0].price : null;
      stop = upLines.length ? upLines[0].price : (atr ? entry + 1.2 * atr : null);
    }
    // 窄止损下限保护（避免贴着入场被噪声扫掉），目标若太近则向上找满足盈亏比≥1的档位
    if (stop !== null) {
      const minGap = Math.max(0.3 * atr, entry * 1e-4);
      if (decision === 'long' && entry - stop < minGap) stop = entry - minGap;
      if (decision === 'short' && stop - entry < minGap) stop = entry + minGap;
    }
    if (target !== null && stop !== null) {
      const stopGap = Math.abs(entry - stop);
      const pool = decision === 'long' ? upLines : dnLines;
      const better = pool.find((ln) => Math.abs(ln.price - entry) >= stopGap);
      target = better ? better.price : null; // 无满足档位则不报目标
    }
  }
  let rewardRisk: number | null = null;
  if (target !== null && stop !== null) {
    rewardRisk = Math.min(3, Math.abs(target - entry) / Math.max(1e-9, Math.abs(entry - stop)));
  }

  return {
    decision,
    label,
    confidence,
    basis: reasons.join(' · ') || '数据不足',
    trendLabel: trend ? trend.label : '--',
    biDir,
    ab9Strength,
    refLine: ab9 ? (ab9.refLineSupport ?? ab9.refLineResistance) : null,
    entry,
    stop,
    target,
    rewardRisk,
  };
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

// ==================== 一目均衡表（Ichimoku Cloud） ====================

export interface IchimokuData {
  // 转换线（快线）
  tenkan: { time: number; price: number }[];
  // 基准线（慢线）
  kijun: { time: number; price: number }[];
  // 迟行线（过去收盘价，后移显示）
  chikou: { time: number; price: number }[];
  // 云（先行带）：time 已外推到未来，top/bottom 为云上沿/下沿
  cloud: { time: number; top: number; bottom: number }[];
  // 云上穿/下穿状态（用于趋势提示）：每点的云方向
}

/**
 * 一目均衡表（Ichimoku Kinko Hyo / Ichimoku Cloud）
 * 五条线组成：
 * - 转换线 tenkan = (9周期高+低)/2   —— 短中期动量
 * - 基准线 kijun = (26周期高+低)/2   —— 中期趋势与反转线（价格站上/跌破为信号）
 * - 迟行线 chikou = 当根收盘价前移26根后绘制 —— 用于二次确认
 * - 先行云带A senkouA = (tenkan+kijun)/2 前移26根
 * - 先行云带B senkouB = (52周期高+低)/2 前移26根
 * A/B 之间的区域即"云"，价格在云上方=多头市场，下方=空头市场，云内=震荡。
 * 云的未来部分（外推）天然是"提前看走势"的支撑/阻力带。
 */
export function calcIchimoku(
  klines: KlineData[],
  quick: number = 9,
  base: number = 26,
  spanB: number = 52,
  disp: number = 26,
): IchimokuData | null {
  const n = klines.length;
  if (n < spanB + 10) return null;

  const mid = (end: number, len: number): number => {
    let h = -Infinity;
    let l = Infinity;
    for (let j = Math.max(0, end - len + 1); j <= end; j++) {
      if (klines[j].high > h) h = klines[j].high;
      if (klines[j].low < l) l = klines[j].low;
    }
    return (h + l) / 2;
  };

  // 快速/基准线（按柱位置）
  const tenkanPts: (number | null)[] = new Array(n).fill(null);
  const kijunPts: (number | null)[] = new Array(n).fill(null);
  for (let i = quick - 1; i < n; i++) tenkanPts[i] = mid(i, quick);
  for (let i = base - 1; i < n; i++) kijunPts[i] = mid(i, base);

  // 迟行线：当根收盘价，绘制在"当前时刻之前 disp 根"的位置，
  // 即当前柱显示的是 disp 根之前的收盘价。数组里 chikou[i] = close[i+disp]
  // 绘制时让它出现在当前值位置，等价于把过去收盘价后移。这里直接用 close 平移。
  const chikou: { time: number; price: number }[] = [];
  for (let i = 0; i < n - disp; i++) {
    chikou.push({ time: klines[i].time, price: klines[i + disp].close });
  }

  const tenkan: { time: number; price: number }[] = [];
  const kijun: { time: number; price: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (tenkanPts[i] !== null) tenkan.push({ time: klines[i].time, price: tenkanPts[i]! });
    if (kijunPts[i] !== null) kijun.push({ time: klines[i].time, price: kijunPts[i]! });
  }

  // 云带：先行跨度 = 基于"当前位 i 之前 disp 根"的数据计算，绘制在位置 i
  // 因此云在图表右端可外推出未来（i 到 n-1+disp 使用还没走出的历史窗口价格）
  const barInterval = n > 1 ? klines[n - 1].time - klines[n - 2].time : 60;
  const lastTime = klines[n - 1].time;
  const timeAt = (i: number): number =>
    i <= n - 1 ? klines[i].time : lastTime + (i - (n - 1)) * barInterval;

  const cloud: { time: number; top: number; bottom: number }[] = [];
  const cloudStart = base - 1 + disp; // 云最早可用位置
  const cloudEnd = n - 1 + disp; // 外推到未来 disp 根
  for (let i = cloudStart; i <= cloudEnd; i++) {
    const src = i - disp; // 云值取自 src 根的数据
    if (src < quick - 1 || src < base - 1) continue;
    const t = tenkanPts[src];
    const k = kijunPts[src];
    if (t === null || k === null) continue;
    const spanA = (t + k) / 2;
    const spanBVal = mid(src, spanB);
    cloud.push({
      time: timeAt(i),
      top: Math.max(spanA, spanBVal),
      bottom: Math.min(spanA, spanBVal),
    });
  }

  return { tenkan, kijun, chikou, cloud };
}

// ==================== 超级趋势（Supertrend） ====================

export interface SupertrendPoint {
  time: number;
  price: number;
  state: 'up' | 'down';
}
export interface SupertrendFlip {
  time: number;
  price: number;
  direction: 'up' | 'down'; // 翻转后进入的方向
}
export interface SupertrendData {
  line: SupertrendPoint[];
  flips: SupertrendFlip[];
  atr: number;
}

/**
 * 超级趋势（Supertrend）
 * 基于 ATR 的动态追踪止损轨道，跟随趋势并给出明确的翻转点：
 * - finalUpper = 若 basicUpper<prevUpper 或 prevClose>prevUpper 取 basicUpper，否则 prevUpper
 * - finalLower 同理
 * - 趋势向上（持有）当 close > finalLower；向下（空头）当 close < finalUpper
 * 速度参数：短周期(10,3)灵敏、长周期(14,5)稳定；
 * 两周期同时同向 = 双周期共振，方向可信度更高。
 */
export function calcSupertrend(
  klines: KlineData[],
  atrPeriod: number = 10,
  multiplier: number = 3,
  ema?: number[],
): SupertrendData | null {
  const n = klines.length;
  if (n < atrPeriod + 5) return null;

  const atr = ema ?? calcATRArray(klines, atrPeriod);
  const hl2 = klines.map((k) => (k.high + k.low) / 2);

  const basicUpper = new Array(n).fill(null!);
  const basicLower = new Array(n).fill(null!);
  const finalUpper = new Array(n).fill(null!);
  const finalLower = new Array(n).fill(null!);
  const state: ('up' | 'down')[] = new Array(n).fill('up');

  for (let i = 0; i < n; i++) {
    const a = atr[i] ?? 0;
    basicUpper[i] = hl2[i] + multiplier * a;
    basicLower[i] = hl2[i] - multiplier * a;
    if (i === 0) {
      finalUpper[i] = basicUpper[i];
      finalLower[i] = basicLower[i];
      state[i] = klines[i].close > finalLower[i] ? 'up' : 'down';
      continue;
    }
    finalUpper[i] =
      basicUpper[i] < finalUpper[i - 1] || klines[i - 1].close > finalUpper[i - 1]
        ? basicUpper[i]
        : finalUpper[i - 1];
    finalLower[i] =
      basicLower[i] > finalLower[i - 1] || klines[i - 1].close < finalLower[i - 1]
        ? basicLower[i]
        : finalLower[i - 1];

    if (state[i - 1] === 'up') {
      state[i] = klines[i].close > finalLower[i] ? 'up' : 'down';
    } else {
      state[i] = klines[i].close < finalUpper[i] ? 'down' : 'up';
    }
  }

  const line: SupertrendPoint[] = [];
  const flips: SupertrendFlip[] = [];
  for (let i = 0; i < n; i++) {
    const price = state[i] === 'up' ? finalLower[i] : finalUpper[i];
    line.push({ time: klines[i].time, price, state: state[i] });
    if (i > 0 && state[i] !== state[i - 1]) {
      flips.push({ time: klines[i].time, price, direction: state[i] });
    }
  }

  return { line, flips, atr: atr[n - 1] ?? 0 };
}

// ==================== ATR 目标区与到价概率 ====================

export interface ATRTargetLevel {
  mult: number; // ATR 倍数
  price: number; // 目标价
  prob: number; // 0~100，历史命中概率
}
export interface ATRTarget {
  price: number; // 当前价
  atr: number; // ATR 波动率
  upTargets: ATRTargetLevel[]; // 上方目标
  downTargets: ATRTargetLevel[]; // 下方目标
}

/**
 * ATR 目标区：用波动率推算"大概率到达的目标价"，并基于历史统计给出到价概率。
 * 不承诺必然到达——给出的是概率区间，用于盈亏比与止盈止损测算。
 * 目标倍数常取 0.5 / 1 / 1.5 倍 ATR。
 * 概率计算：在历史 lookback 根K线里，统计"未来 horizon 根内价格
 * 自起点位移达到 ±k·ATR 的比例"，作为到价概率的近似估计。
 */
export function calcATRTargets(
  klines: KlineData[],
  atrPeriod: number = 14,
  horizon: number = 12,
  lookback: number = 150,
  mults: number[] = [0.5, 1, 1.5],
): ATRTarget | null {
  const n = klines.length;
  if (n < 60) return null;
  const price = klines[n - 1].close;
  const atrArr = calcATRArray(klines, atrPeriod);
  const atr = atrArr[n - 1] ?? 0;
  if (atr <= 0) return null;

  // 历史命中率统计
  const hitCount = new Map<number, { up: number; dn: number }>();
  mults.forEach((m) => hitCount.set(m, { up: 0, dn: 0 }));
  const start = Math.max(0, n - lookback);
  const barAtMove = Math.min(horizon, n - start - 1);
  for (let i = start; i < n - 1 && barAtMove > 0; i++) {
    const a = atrArr[i] ?? atr;
    if (a <= 0) continue;
    const base = klines[i].close;
    const maxUp = base + 1.5 * a;
    const maxDn = base - 1.5 * a;
    for (let j = 1; j <= barAtMove && i + j < n; j++) {
      const k = klines[i + j];
      for (const m of mults) {
        const rec = hitCount.get(m)!;
        if (rec.up === 0 && k.high >= base + m * a) rec.up = 1;
        if (rec.dn === 0 && k.low <= base - m * a) rec.dn = 1;
      }
    }
  }
  const total = Math.max(barAtMove, 1);
  const upTargets: ATRTargetLevel[] = [];
  const downTargets: ATRTargetLevel[] = [];
  mults.forEach((m) => {
    const rec = hitCount.get(m)!;
    upTargets.push({
      mult: m,
      price: price + m * atr,
      prob: Math.min(100, Math.round((rec.up / total) * 100)),
    });
    downTargets.push({
      mult: m,
      price: price - m * atr,
      prob: Math.min(100, Math.round((rec.dn / total) * 100)),
    });
  });

  return { price, atr, upTargets, downTargets };
}

// ==================== 顶/底背离自动识别 ====================

export interface DivergencePoint {
  time: number;
  price: number;
  type: 'bullish' | 'bearish'; // 底部背离(看涨) / 顶部背离(看跌)
  source: 'RSI';
}

/**
 * RSI 与价格背离检测（拐点预警，不是信号，是有概率意义的反转提示）
 * - 顶背离：价格创更高高点，而 RSI 未同步创新高（动量走弱）→ 潜在下跌
 * - 底背离：价格创更低下低点，而 RSI 未同步创新低（动能衰竭）→ 潜在反弹
 * 用窗宽 window 找价格 pivot 高低点，再对比相邻两个同向 pivot 的价格与 RSI 走势。
 */
export function calcDivergence(
  klines: KlineData[],
  rsiPeriod: number = 14,
  window: number = 4,
): DivergencePoint[] {
  const n = klines.length;
  if (n < rsiPeriod + window * 2 + 5) return [];
  const rsiArr = calcRSIArray(klines, rsiPeriod);
  const points: DivergencePoint[] = [];

  // 收集 pivot 高点 / 低点（严格窗内极值）
  const pivHighIdx: number[] = [];
  const pivLowIdx: number[] = [];
  for (let i = window; i < n - window; i++) {
    let isPh = true;
    let isPl = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (klines[j].high >= klines[i].high) isPh = false;
      if (klines[j].low <= klines[i].low) isPl = false;
    }
    if (isPh) pivHighIdx.push(i);
    if (isPl) pivLowIdx.push(i);
  }

  // 顶背离：相邻两个 pivot 高点，价格抬升但 RSI 走低
  for (let k = 1; k < pivHighIdx.length; k++) {
    const i1 = pivHighIdx[k - 1];
    const i2 = pivHighIdx[k];
    const r1 = rsiArr[i1];
    const r2 = rsiArr[i2];
    if (r1 === null || r2 === null) continue;
    if (klines[i2].high > klines[i1].high * 1.0001 && r2 < r1) {
      points.push({
        time: klines[i2].time,
        price: klines[i2].high,
        type: 'bearish',
        source: 'RSI',
      });
    }
  }
  // 底背离：相邻两个 pivot 低点，价格走低但 RSI 走高
  for (let k = 1; k < pivLowIdx.length; k++) {
    const i1 = pivLowIdx[k - 1];
    const i2 = pivLowIdx[k];
    const r1 = rsiArr[i1];
    const r2 = rsiArr[i2];
    if (r1 === null || r2 === null) continue;
    if (klines[i2].low < klines[i1].low * 0.9999 && r2 > r1) {
      points.push({
        time: klines[i2].time,
        price: klines[i2].low,
        type: 'bullish',
        source: 'RSI',
      });
    }
  }

  return points.slice(-12); // 只保留最近若干，避免图上杂乱
}

// ==================== 预测信号合成器 ====================

export interface SynthSignal {
  label: string; // 短标签
  text: string; // 说明
  tone: 'bullish' | 'bearish' | 'neutral';
}
export interface PredictionSynth {
  direction: 'up' | 'down' | 'neutral'; // 合成方向
  confidence: number; // 0~100 置信度
  supertrendFast: SupertrendData;
  supertrendSlow: SupertrendData;
  atrTarget: ATRTarget | null;
  divergences: DivergencePoint[];
  signals: SynthSignal[]; // 人类可读的信号解释
}

/**
 * 预测信号合成器
 * 把多个独立信号糅合成"一条主线"，给用户直观的方向 + 置信度 + 目标位 + 拐点预警：
 * 1. 双周期 Supertrend 共振（快 10/3 + 慢 14/5）：方向与翻转
 * 2. ATR 目标区：大概率到价区间（含历史概率）
 * 3. RSI 背离：反转拐点预警
 * 方向置信度 = 50 + 共振偏置 + 动量微调，夹逼到 5~95，避免"确定性承诺"。
 */
export function calcPredictionSynth(
  klines: KlineData[],
): PredictionSynth | null {
  const n = klines.length;
  if (n < 70) return null;

  const fastST = calcSupertrend(klines, 10, 3);
  const slowST = calcSupertrend(klines, 14, 5);
  if (!fastST || !slowST) return null;

  const atrTarget = calcATRTargets(klines, 14, 12, 150);
  const divergences = calcDivergence(klines, 14, 4);

  // 共振方向
  const fastUp = fastST.line[fastST.line.length - 1].state === 'up';
  const slowUp = slowST.line[slowST.line.length - 1].state === 'up';

  // RSI 动量微调
  const rsiArr = calcRSIArray(klines, 14);
  const lastRsi = rsiArr[n - 1];

  let confidence = 50;
  const signals: SynthSignal[] = [];

  if (fastUp === slowUp) {
    if (fastUp) {
      confidence += 25;
      signals.push({ label: '双周期共振', text: '快慢超趋势同向偏多', tone: 'bullish' });
    } else {
      confidence -= 25;
      signals.push({ label: '双周期共振', text: '快慢超趋势同向偏空', tone: 'bearish' });
    }
  } else {
    signals.push({ label: '方向分歧', text: '快慢超趋势取向不一，震荡概率大', tone: 'neutral' });
  }

  if (lastRsi !== null) {
    if (lastRsi > 55) {
      confidence += 8;
      if (confidence >= 55) signals.push({ label: '动量', text: `RSI ${lastRsi.toFixed(0)} 偏多`, tone: 'bullish' });
    } else if (lastRsi < 45) {
      confidence -= 8;
      if (confidence <= 45) signals.push({ label: '动量', text: `RSI ${lastRsi.toFixed(0)} 偏空`, tone: 'bearish' });
    }
  }

  // 背离提示
  const newestDiv = divergences[divergences.length - 1];
  if (newestDiv) {
    if (newestDiv.type === 'bearish') {
      signals.push({ label: '顶背离', text: '近期出现顶部背离，注意回撤', tone: 'bearish' });
      confidence -= 5;
    } else {
      signals.push({ label: '底背离', text: '近期出现底部背离，警惕反弹', tone: 'bullish' });
      confidence += 5;
    }
  }

  confidence = Math.max(5, Math.min(95, confidence));
  const direction = confidence >= 55 ? 'up' : confidence <= 45 ? 'down' : 'neutral';

  return {
    direction,
    confidence,
    supertrendFast: fastST,
    supertrendSlow: slowST,
    atrTarget,
    divergences,
    signals,
  };
}

// ==================== 综合合流锚线（Composite Anchor Line） ====================

export interface CompositeLineData {
  time: number;
  value: number; // 锚线价格
}

export interface CompositeLine {
  // 锚线序列（可直接作为主图 line series 数据）
  data: CompositeLineData[];
  // 最后一根的多空合流偏置（-1 空 ~ +1 多）
  lastBias: number;
  // 多空合流方向
  direction: 'up' | 'down' | 'neutral';
  // 最新一根锚线值
  anchorValue: number;
  // 最新一幅的分项原始信号（供诊断/展示）
  components: { ema: number; macd: number; rsi: number; st: number; volume: number };
}

/**
 * 综合合流锚线：把 EMA 趋势 + MACD 动量 + RSI + 超趋势 + 成交量 合成一条主图叠加线。
 *
 * 原理：
 *  - 各指标归一化到 [-1, 1] 的多空偏置，按权重合成为 bias；
 *  - 成交量放大时强化合流方向、缩量时弱化（可信度调节）；
 *  - 锚线 = EMA20 - bias * ATR * SHIFT；bias>0（偏多）→ 锚线在价格下方，
 *    价格「在锚线上方 = 多方合流」，反之偏空。多空冲突时锚线贴近价格。
 */
export function calcCompositeLine(klines: KlineData[]): CompositeLine | null {
  const n = klines.length;
  if (!klines || n < 60) return null;

  const ema20 = calcEMAArray(klines, 20);
  const macd = calcMACD(klines, 12, 26, 9);
  const rsi = calcRSIArray(klines, 14);
  const st = calcSupertrend(klines, 10, 3);
  const atr = calcATRArray(klines, 14);
  if (!macd || !st) return null;

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // 成交量均线（周期 20）
  const volAvg: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (i < 20) { volAvg.push(null); continue; }
    let s = 0;
    for (let j = i - 19; j <= i; j++) s += klines[j].volume;
    volAvg.push(s / 20);
  }

  const data: CompositeLineData[] = [];
  const SCALE = 1.5;  // 价格归一化：偏差 / (ATR*SCALE)
  const SHIFT = 0.6;  // 锚线相对 EMA20 的偏移幅度（ATR 倍数），具体越大越醒目

  let lastBias = 0;
  let lastComp = { ema: 0, macd: 0, rsi: 0, st: 0, volume: 1 };

  for (let i = 40; i < n; i++) {
    const a = atr[i];
    if (!a || !isFinite(a) || a === 0) continue;

    // 1) EMA 趋势：价格相对 EMA20（归一化到 ATR）
    const emaSig = clamp((klines[i].close - ema20[i]) / (a * SCALE), -1, 1);

    // 2) MACD 动量：柱状图 / ATR
    const macdSig = clamp((macd.hist[i] ?? 0) / (a * SCALE), -1, 1);

    // 3) RSI 强度：(RSI-50)/50
    const rsiSig = clamp(((rsi[i] ?? 50) - 50) / 50, -1, 1);

    // 4) 超趋势方向
    const stSig = st.line[i]?.state === 'up' ? 1 : -1;

    // 5) 成交量确认：放量强化/缩量弱化合流方向
    const va = volAvg[i];
    const volFactor = va && va > 0 ? clamp(klines[i].volume / va, 0, 3) : 1;
    const volMod = volFactor >= 1.5 ? 1.25 : volFactor <= 0.8 ? 0.8 : 1;

    // 合成多空偏置（-1 ~ 1）
    const rawBias = 0.30 * emaSig + 0.25 * macdSig + 0.20 * rsiSig + 0.25 * stSig;
    const bias = clamp(rawBias * volMod, -1, 1);

    // 锚线值
    const anchor = ema20[i] - bias * a * SHIFT;

    lastBias = bias;
    lastComp = { ema: emaSig, macd: macdSig, rsi: rsiSig, st: stSig, volume: volFactor };
    data.push({ time: klines[i].time, value: Math.round(anchor * 10000) / 10000 });
  }

  if (data.length === 0) return null;
  const anchorValue = data[data.length - 1].value;
  const direction = lastBias > 0.1 ? 'up' : lastBias < -0.1 ? 'down' : 'neutral';

  return {
    data,
    lastBias: Math.round(lastBias * 100) / 100,
    direction,
    anchorValue,
    components: lastComp,
  };
}

// ==================== 动态统计回调带（回调线 / 深度回调线） ====================

export interface PullbackBands {
  direction: 'up' | 'down'; // 当前是上升(up)还是下降(down)语境
  anchorTime: number;       // 最近确认摆动点的 K 线时间
  anchorPrice: number;      // 锚点价格（上升=最近摆动顶，下降=最近摆动底）
  typicalLevel: number;     // 回调线价格（典型回调深度）
  deepLevel: number;        // 深度回调线价格（深度回调深度）
  typicalATR: number;       // 典型回调深度（ATR 倍数）
  deepATR: number;          // 深度回调深度（ATR 倍数）
  retestLevel: number | null; // 回踩线价格（被多次触及的关键水平位，无则 null）
  retestTouches: number;    // 回踩位被触及的次数（≥2 才算回踩位）
  retestType: 'support' | 'resistance' | null; // 回踩位相对当前价是支撑还是阻力
  currentATR: number;       // 最新 ATR（用于读写阅读）
  samples: number;          // 实际使用的回调样本数
}

/** 分位数（sorted 升序数组） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * 动态统计回调带：不画固定比例，而是统计最近 N 段实际回调的深度（用 ATR 归一化）。
 *
 * 步骤：
 *  1) ZigZag 摆动点识别（阈值 = ATR × zigzagATR，行走量达到才记为一次摆动），得到顶/底摆动点；
 *  2) 按当前语境（最近摆动点是顶→上升语境）收集对应的回调动程样本（顶→底 或 底→顶）深度 / ATR；
 *  3) 回调线 = 样本中位数深度，深度回调线 = 样本 85 分位深度（值都是 ATR 倍数）；
 *  4) 在最新摆动点处按当前 ATR 换算成价格水平：上升语境线在锚点下方，下降语境在锚点上方。
 */
export function calcPullbackBands(
  klines: KlineData[],
  atrPeriod = 14,
  zigzagATR = 1.2,
): PullbackBands | null {
  const n = klines.length;
  if (!klines || n < 40) return null;

  const atr = calcATRArray(klines, atrPeriod);

  // ---- 1) ZigZag 摆动点识别 ----
  const pivots: { index: number; time: number; price: number; type: 'top' | 'bottom' }[] = [];
  let state: 'up' | 'down' = 'up';
  let runExtreme: { index: number; price: number } | null = null;

  for (let i = 1; i < n; i++) {
    const thr = (atr[i] || 0) * zigzagATR;
    if (state === 'up') {
      if (!runExtreme || klines[i].high >= runExtreme.price) {
        runExtreme = { index: i, price: klines[i].high };
      }
      if (klines[i].low <= runExtreme.price - thr) {
        pivots.push({ index: runExtreme.index, time: klines[runExtreme.index].time, price: runExtreme.price, type: 'top' });
        state = 'down';
        runExtreme = { index: i, price: klines[i].low };
      }
    } else {
      if (!runExtreme || klines[i].low <= runExtreme.price) {
        runExtreme = { index: i, price: klines[i].low };
      }
      if (klines[i].high >= runExtreme.price + thr) {
        pivots.push({ index: runExtreme.index, time: klines[runExtreme.index].time, price: runExtreme.price, type: 'bottom' });
        state = 'up';
        runExtreme = { index: i, price: klines[i].high };
      }
    }
  }

  if (pivots.length < 2) return null;
  const lastPivot = pivots[pivots.length - 1];
  const lastClose = klines[n - 1].close;
  const currentATR = atr[n - 1] || atr[n - 2] || 0;
  if (currentATR <= 0) return null;

  // 当前活跃腿：最后摆动点为"底"→ 价格自底上行（上升腿）；为"顶"→ 自顶下行（下降腿）
  const direction: 'up' | 'down' = lastPivot.type === 'bottom' ? 'up' : 'down';
  const legStart = lastPivot.index;

  // 腿内的高低极值：回调/反弹线必须落在腿内，而不是越出行情之外
  let legLow: number, legHigh: number, anchorPrice: number;
  if (direction === 'up') {
    legLow = lastPivot.price;
    let hi = legLow;
    for (let i = legStart; i < n; i++) if (klines[i].high > hi) hi = klines[i].high;
    legHigh = hi;
    anchorPrice = legHigh;
  } else {
    legHigh = lastPivot.price;
    let lo = legHigh;
    for (let i = legStart; i < n; i++) if (klines[i].low < lo) lo = klines[i].low;
    legLow = lo;
    anchorPrice = legLow;
  }
  const range = legHigh - legLow;
  if (range <= 0) return null;

  // ---- 2) 收集同方向历史调/反弹动程样本 ----
  const samples: number[] = [];
  for (let p = 0; p + 1 < pivots.length; p++) {
    const a = pivots[p];
    const b = pivots[p + 1];
    const av = atr[a.index] || 0;
    if (av <= 0) continue;
    if (direction === 'up' && a.type === 'top' && b.type === 'bottom') {
      samples.push((a.price - b.price) / av);   // 上升语境：从高点的回调跌程
    } else if (direction === 'down' && a.type === 'bottom' && b.type === 'top') {
      samples.push((b.price - a.price) / av);   // 下降语境：从低点的反弹升程
    }
  }

  // ---- 3) 深度分位数，并夹回到当前腿的 ATR 预算内 ----
  let typical: number;
  let deep: number;
  if (samples.length >= 3) {
    const sorted = [...samples].sort((x, y) => x - y);
    typical = percentile(sorted, 0.5);
    deep = percentile(sorted, 0.85);
  } else {
    typical = 0.8;
    deep = 1.6;
  }
  const maxATR = range / currentATR;
  typical = Math.min(Math.max(typical, maxATR * 0.2), maxATR * 0.7);
  deep = Math.min(Math.max(deep, Math.min(typical + maxATR * 0.15, maxATR * 0.85)), maxATR * 0.9);

  const typicalLevel = direction === 'up'
    ? legHigh - typical * currentATR
    : legLow + typical * currentATR;
  const deepLevel = direction === 'up'
    ? legHigh - deep * currentATR
    : legLow + deep * currentATR;

  // ---- 4) 回踩位：贴近现价但非重合、且被多次触及的水平支撑/阻力 ----
  const tol = Math.max(currentATR * 0.12, lastClose * 0.0005); // 触及容差
  const minSep = Math.max(currentATR * 0.3, lastClose * 0.002); // 与现价最小间距（杜绝线贴住现价）
  const band = currentATR * 4;                                  // 可接受的回踩带
  const clusters: { price: number; count: number }[] = [];
  for (const p of pivots) {
    const hit = clusters.find(c => Math.abs(c.price - p.price) <= tol);
    if (hit) hit.count += 1;
    else clusters.push({ price: p.price, count: 1 });
  }
  const byDist = (a: { price: number }, b: { price: number }) => Math.abs(a.price - lastClose) - Math.abs(b.price - lastClose);
  const supportCands = clusters.filter(c => c.price < lastClose - minSep && (lastClose - c.price) <= band);
  const resistCands = clusters.filter(c => c.price > lastClose + minSep && (c.price - lastClose) <= band);
  // 越精准越好：先看"被多次触及"的更强水平位，其次用最近的摆动位兜底
  const multiSup = supportCands.filter(c => c.count >= 2).sort(byDist);
  const multiRes = resistCands.filter(c => c.count >= 2).sort(byDist);
  const anySup = supportCands.sort(byDist);
  const anyRes = resistCands.sort(byDist);
  const sup = multiSup[0] || anySup[0];
  const res = multiRes[0] || anyRes[0];
  let retestLevel: number | null = null;
  let retestTouches = 0;
  let retestType: 'support' | 'resistance' | null = null;
  // 回踩语义：优先取下方支撑（价格回落到的支撑区），无支撑时才用上方阻力作反弹位
  if (sup) {
    retestLevel = Math.round(sup.price * 100) / 100;
    retestTouches = sup.count;
    retestType = 'support';
  } else if (res) {
    retestLevel = Math.round(res.price * 100) / 100;
    retestTouches = res.count;
    retestType = 'resistance';
  }

  return {
    direction,
    anchorTime: lastPivot.time,
    anchorPrice,
    typicalLevel: Math.round(typicalLevel * 100) / 100,
    deepLevel: Math.round(deepLevel * 100) / 100,
    typicalATR: Math.round(typical * 100) / 100,
    deepATR: Math.round(deep * 100) / 100,
    retestLevel,
    retestTouches,
    retestType,
    currentATR: Math.round(currentATR * 100) / 100,
    samples: samples.length,
  };
}

// ADX / DMI（趋势质量过滤）
// +DI / -DI 反映多空方向强度，ADX 反映趋势强弱(通常 >25 视为有趋势，<20 视为震荡)。
// 采用 Wilder 平滑，与 ATR 同源。
export interface ADXData {
  pdi: (number | null)[]; // +DI
  mdi: (number | null)[]; // -DI
  adx: (number | null)[];
  plusDI: number; // 最新 +DI
  minusDI: number; // 最新 -DI
  lastADX: number; // 最新 ADX
  direction: 'bull' | 'bear' | 'osc'; // 由 +DI/-DI 快判
}

export function calcADX(klines: KlineData[], period: number = 14): ADXData | null {
  const n = klines.length;
  if (!klines || n < Math.max(period + 1, period * 2)) return null;

  const pdi: (number | null)[] = new Array(n).fill(null);
  const mdi: (number | null)[] = new Array(n).fill(null);
  const adx: (number | null)[] = new Array(n).fill(null);

  const hl = (i: number) => Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close));
  const pdm = (i: number) => { const up = klines[i].high - klines[i - 1].high; const dn = klines[i - 1].low - klines[i].low; return up > dn && up > 0 ? up : 0; };
  const mdm = (i: number) => { const up = klines[i].high - klines[i - 1].high; const dn = klines[i - 1].low - klines[i].low; return dn > up && dn > 0 ? dn : 0; };

  // 种子：前 period 个值的 Wilder 均值
  let smTR = 0, smPDM = 0, smMDM = 0;
  for (let i = 1; i <= period; i++) { smTR += hl(i); smPDM += pdm(i); smMDM += mdm(i); }
  let atr = smTR / period, plus = smPDM / period, minus = smMDM / period;

  let lastPlus = 0, lastMinus = 0, lastAdx = 0;
  let adxVal = 0;
  const dxBuf: number[] = [];
  for (let i = period; i < n; i++) {
    if (i > period) {
      const tr = hl(i); const p = pdm(i); const m = mdm(i);
      atr = (atr * (period - 1) + tr) / period;
      plus = (plus * (period - 1) + p) / period;
      minus = (minus * (period - 1) + m) / period;
    }
    const pdiV = atr > 0 ? (100 * plus) / atr : 0;
    const mdiV = atr > 0 ? (100 * minus) / atr : 0;
    const sum = pdiV + mdiV;
    const dx = sum > 0 ? (100 * Math.abs(pdiV - mdiV)) / sum : 0;
    pdi[i] = Math.round(pdiV * 100) / 100;
    mdi[i] = Math.round(mdiV * 100) / 100;
    lastPlus = pdi[i] as number; lastMinus = mdi[i] as number;
    dxBuf.push(dx);
    if (dxBuf.length === period) { adxVal = dxBuf.reduce((a, b) => a + b, 0) / period; const r = Math.round(adxVal * 100) / 100; adx[i] = r; lastAdx = r; }
    else if (dxBuf.length > period) { adxVal = (adxVal * (period - 1) + dx) / period; const r = Math.round(adxVal * 100) / 100; adx[i] = r; lastAdx = r; }
  }

  const direction: 'bull' | 'bear' | 'osc' = Math.abs(lastPlus - lastMinus) < 4 ? 'osc' : lastPlus > lastMinus ? 'bull' : 'bear';
  return { pdi, mdi, adx, plusDI: lastPlus, minusDI: lastMinus, lastADX: lastAdx, direction };
}

// SuperTrend（ATR 趋势跟踪 · 机械可回测）
// 上下轨 = 中点 ± multiplier×ATR，趋势内只向有利方向推动轨道，
// 价格触及反向轨道即反转方向。默认 (10, 3)、常见 (14, 3)。
export interface SuperTrendPoint { value: number | null; isUp: boolean | null; }
export interface SuperTrendData {
  points: SuperTrendPoint[];
  lastValue: number | null;
  lastIsUp: boolean | null;
}

export function calcSuperTrend(klines: KlineData[], period: number = 10, multiplier: number = 3): SuperTrendData {
  const n = klines.length;
  const points: SuperTrendPoint[] = new Array(n).fill(null).map(() => ({ value: null, isUp: null }));
  if (!klines || n <= period + 1) return { points, lastValue: null, lastIsUp: null };

  const atr = calcATRArray(klines, period);
  const mid0 = (klines[period].high + klines[period].low) / 2;
  const u0 = mid0 + multiplier * (atr[period] as number);
  const l0 = mid0 - multiplier * (atr[period] as number);
  let finalUpper = u0;
  let finalLower = l0;
  let trend: 'up' | 'down' = klines[period].close >= mid0 ? 'up' : 'down';
  points[period] = { value: trend === 'up' ? finalUpper : finalLower, isUp: trend === 'up' };

  for (let i = period + 1; i < n; i++) {
    const av = atr[i] as number;
    const mid = (klines[i].high + klines[i].low) / 2;
    const baseU = mid + multiplier * av;
    const baseL = mid - multiplier * av;
    if (klines[i].close <= finalUpper) finalUpper = baseU; else finalUpper = Math.max(finalUpper, baseU);
    if (klines[i].close >= finalLower) finalLower = baseL; else finalLower = Math.min(finalLower, baseL);
    if (trend === 'up') {
      if (klines[i].close < finalLower) { trend = 'down'; points[i] = { value: finalLower, isUp: false }; }
      else { points[i] = { value: finalUpper, isUp: true }; }
    } else {
      if (klines[i].close > finalUpper) { trend = 'up'; points[i] = { value: finalUpper, isUp: true }; }
      else { points[i] = { value: finalLower, isUp: false }; }
    }
  }
  const last = points[n - 1];
  return { points, lastValue: last ? last.value : null, lastIsUp: last ? last.isUp : null };
}

