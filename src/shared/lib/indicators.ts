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

// ========== 缠论（Chanlun）分型→笔→中枢 ==========

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
}

export interface ChanResult {
  fractals: ChanFractal[];
  bis: ChanBi[];
  zhongshus: ChanZhongshu[];
}

// 分型识别：顶分型 = 高点高于左右相邻，底分型 = 低点低于左右相邻
function detectFractals(klines: KlineData[]): ChanFractal[] {
  const fractals: ChanFractal[] = [];
  for (let i = 1; i < klines.length - 1; i++) {
    const prev = klines[i - 1];
    const curr = klines[i];
    const next = klines[i + 1];
    // 顶分型：高点最高 + 低点也最高（标准缠论定义）
    if (curr.high > prev.high && curr.high > next.high &&
        curr.low > prev.low && curr.low > next.low) {
      fractals.push({ index: i, time: curr.time, price: curr.high, type: 'top' });
    }
    // 底分型：低点最低 + 高点也最低
    if (curr.low < prev.low && curr.low < next.low &&
        curr.high < prev.high && curr.high < next.high) {
      fractals.push({ index: i, time: curr.time, price: curr.low, type: 'bottom' });
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

// 中枢：至少3笔价格区间重叠
function buildZhongshu(bis: ChanBi[]): ChanZhongshu[] {
  const zhongshus: ChanZhongshu[] = [];
  if (bis.length < 3) return zhongshus;

  for (let i = 0; i <= bis.length - 3; i++) {
    // 取连续3笔
    const b1 = bis[i], b2 = bis[i + 1], b3 = bis[i + 2];
    // 每笔的价格区间
    const r1Low = Math.min(b1.startPrice, b1.endPrice);
    const r1High = Math.max(b1.startPrice, b1.endPrice);
    const r2Low = Math.min(b2.startPrice, b2.endPrice);
    const r2High = Math.max(b2.startPrice, b2.endPrice);
    const r3Low = Math.min(b3.startPrice, b3.endPrice);
    const r3High = Math.max(b3.startPrice, b3.endPrice);
    // 重叠区间 = [max(低点), min(高点)]
    const overlapLow = Math.max(r1Low, r2Low, r3Low);
    const overlapHigh = Math.min(r1High, r2High, r3High);
    if (overlapLow < overlapHigh) {
      // 有重叠 → 形成中枢
      // 合并相邻中枢
      const last = zhongshus[zhongshus.length - 1];
      if (last && b1.startTime <= last.endTime) {
        // 相邻中枢合并
        last.endTime = b3.endTime;
        last.high = Math.min(last.high, overlapHigh);
        last.low = Math.max(last.low, overlapLow);
        last.biCount += 1;
      } else {
        zhongshus.push({
          startTime: b1.startTime,
          endTime: b3.endTime,
          high: overlapHigh,
          low: overlapLow,
          biCount: 3,
        });
      }
    }
  }
  return zhongshus;
}

export function calcChan(klines: KlineData[]): ChanResult {
  const fractals = detectFractals(klines);
  const bis = buildBi(fractals, klines);
  const zhongshus = buildZhongshu(bis);
  return { fractals, bis, zhongshus };
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

