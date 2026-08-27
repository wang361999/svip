/**
 * 结构共振交易法 · 规则引擎
 *
 * 职责：把三周期 K 线算成结构化分析数据（所有数字都在这里产生）
 * - 三周期趋势判定（4h/1h/15m：EMA20/60 + MACD + 高低点结构）
 * - 本腿识别（最近的显著推动腿）
 * - 斐波那契回撤/扩展 + 江恩八分位 + 成交密集区
 * - A/B 双预案生成 + 盈亏比测算 + 失效条件
 *
 * 设计原则：纯函数、零副作用、确定性 —— 同样的 K 线永远算出同样的数字。
 * AI 层只负责把这些数字组织成文字，不允许自己算数。
 *
 * 触及概率为经验校准值：基于 ETH/BTC/SOL 4h×4000 根（2024-10~2026-08）
 * 走查回放 16,606 个目标位样本统计得出（见 TOUCH_CALIB），非理论模型推导。
 * 校准数据的局限：仅覆盖三个主流币、约 22 个月行情；极端行情与小币种
 * 的实际触及率可能偏离校准值。
 */

import { KlineData } from './market-data';

// ==================== 基础指标 ====================

/** EMA 数组（与 indicators.ts 相同的种子方式，保证一致性） */
function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      seedSum += values[i];
      out.push(seedSum / (i + 1));
    } else if (i === period - 1) {
      seedSum += values[i];
      out.push(seedSum / period);
    } else {
      out.push(values[i] * k + out[i - 1] * (1 - k));
    }
  }
  return out;
}

export interface MacdSnapshot {
  dif: number;
  dea: number;
  hist: number;
  prevHist: number;
}

function macdSnapshot(closes: number[]): MacdSnapshot | null {
  if (closes.length < 40) return null;
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const dif = closes.map((c, i) => c - e26[i]);
  // DEA = DIF 的 EMA9
  const k = 2 / 10;
  const dea: number[] = [dif[0]];
  for (let i = 1; i < dif.length; i++) dea.push(dif[i] * k + dea[i - 1] * (1 - k));
  const last = closes.length - 1;
  const hist = (dif[last] - dea[last]) * 2;
  const prevHist = (dif[last - 1] - dea[last - 1]) * 2;
  return { dif: dif[last], dea: dea[last], hist, prevHist };
}

// ==================== 摆动点 ====================

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
}

/** 分形摆动点（left/right 各 3 根确认） */
function findSwings(klines: KlineData[], left = 3, right = 3): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = [];
  const lows: SwingPoint[] = [];
  for (let i = left; i < klines.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (klines[j].high >= klines[i].high) isHigh = false;
      if (klines[j].low <= klines[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, time: klines[i].time, price: klines[i].high });
    if (isLow) lows.push({ index: i, time: klines[i].time, price: klines[i].low });
  }
  return { highs, lows };
}

// ==================== 单周期趋势 ====================

export type TrendDir = 'bull' | 'bear' | 'ranging';

export interface PeriodTrend {
  dir: TrendDir;
  score: number;
  maState: 'long' | 'short' | 'mixed';
  macdState: 'bull' | 'bear' | 'mixed';
  structure: 'bull' | 'bear' | 'ranging';
  ema20: number;
  ema60: number;
  price: number;
}

/** 单周期趋势：均线 + MACD + 结构，各 ±1 分，|得分|>=2 才算趋势 */
function calcPeriodTrend(klines: KlineData[]): PeriodTrend {
  const closes = klines.map((k) => k.close);
  const e20 = emaSeries(closes, 20);
  const e60 = emaSeries(closes, 60);
  const price = closes[closes.length - 1];

  const maState =
    price > e20[e20.length - 1] && e20[e20.length - 1] > e60[e60.length - 1]
      ? 'long'
      : price < e20[e20.length - 1] && e20[e20.length - 1] < e60[e60.length - 1]
        ? 'short'
        : 'mixed';

  const macd = macdSnapshot(closes);
  const macdState = !macd
    ? 'mixed'
    : macd.dif > macd.dea && macd.hist > macd.prevHist
      ? 'bull'
      : macd.dif < macd.dea && macd.hist < macd.prevHist
        ? 'bear'
        : 'mixed';

  // 结构：最近两个摆动高/低的 HH/HL/LH/LL
  const { highs, lows } = findSwings(klines.slice(-80));
  let structure: 'bull' | 'bear' | 'ranging' = 'ranging';
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) structure = 'bull';
    else if (lh && ll) structure = 'bear';
  }

  let score = 0;
  if (maState === 'long') score += 1;
  if (maState === 'short') score -= 1;
  if (macdState === 'bull') score += 1;
  if (macdState === 'bear') score -= 1;
  if (structure === 'bull') score += 1;
  if (structure === 'bear') score -= 1;

  const dir: TrendDir = score >= 2 ? 'bull' : score <= -2 ? 'bear' : 'ranging';
  return { dir, score, maState, macdState, structure, ema20: e20[e20.length - 1], ema60: e60[e60.length - 1], price };
}

// ==================== 本腿识别 ====================

export interface Leg {
  /** 上涨腿 or 下跌腿 */
  direction: 'up' | 'down';
  /** 腿起点价（低点或高点） */
  startPrice: number;
  startTime: number;
  /** 腿终点价 */
  endPrice: number;
  endTime: number;
  /** 腿长（绝对值） */
  range: number;
  /** 腿长百分比 */
  rangePct: number;
  /** 当前价相对腿的回撤比例（0=在终点，1=回到起点） */
  retracement: number;
  fibRetracements: { ratio: number; price: number }[];
  fibExtensions: { ratio: number; price: number }[];
}

/** ZigZag 摆动点（振幅阈值过滤，只保留显著推动结构的端点） */
export interface ZigzagPoint {
  type: 'H' | 'L';
  price: number;
  time: number;
}

/**
 * ZigZag：相邻摆动点间变动 >= threshold 才确认
 * 返回已确认摆动点序列 + 当前追踪方向
 *   dir='down' 表示正从（未确认或已确认的）高点回落
 *   dir='up' 表示正从低点反弹
 */
function zigzag(klines: KlineData[], threshold = 0.03): { points: ZigzagPoint[]; dir: 'up' | 'down' | null; pendingExtreme: number } {
  const points: ZigzagPoint[] = [];
  if (klines.length < 10) return { points, dir: null, pendingExtreme: klines.length ? klines[0].close : 0 };

  let dir: 'up' | 'down' | null = null;
  let curHigh = { price: klines[0].high, time: klines[0].time };
  let curLow = { price: klines[0].low, time: klines[0].time };

  for (const k of klines) {
    if (dir === 'up') {
      if (k.high >= curHigh.price) {
        curHigh = { price: k.high, time: k.time };
      } else if (curHigh.price - k.low >= curHigh.price * threshold) {
        // 从高点回撤超阈值 → 确认摆动高，转 down
        points.push({ type: 'H', price: curHigh.price, time: curHigh.time });
        dir = 'down';
        curLow = { price: k.low, time: k.time };
      }
    } else if (dir === 'down') {
      if (k.low <= curLow.price) {
        curLow = { price: k.low, time: k.time };
      } else if (k.high - curLow.price >= curLow.price * threshold) {
        points.push({ type: 'L', price: curLow.price, time: curLow.time });
        dir = 'up';
        curHigh = { price: k.high, time: k.time };
      }
    } else {
      // 初始化：等待首个阈值突破
      if (k.high > curHigh.price) curHigh = { price: k.high, time: k.time };
      if (k.low < curLow.price) curLow = { price: k.low, time: k.time };
      if (curHigh.price - k.low >= curHigh.price * threshold) {
        points.push({ type: 'L', price: curLow.price, time: curLow.time });
        dir = 'up';
        curHigh = { price: k.high, time: k.time };
      } else if (k.high - curLow.price >= curLow.price * threshold) {
        points.push({ type: 'H', price: curHigh.price, time: curHigh.time });
        dir = 'down';
        curLow = { price: k.low, time: k.time };
      }
    }
  }

  // 未确认的极值（腿延续中会继续上移/下移）
  const pendingExtreme = dir === 'up' ? curHigh.price : dir === 'down' ? curLow.price : 0;
  return { points, dir, pendingExtreme };
}

/**
 * 识别"当前正在回撤的那条腿"（结构交易法锚定方式）
 *
 * 用 ZigZag（4% 阈值）找显著推动结构，腿端点允许未确认（跟随最新极值）：
 *   - dir='down' + 最后确认 H → 上涨腿（H 前的 L → H），当前从 H 回落
 *   - dir='up' + 最后确认 L → 两种：前有 H = 下跌腿反弹；无 H = 上涨腿延续中（L → 未确认高点）
 * 未确认端点用当前追踪极值，保证"回撤深度"始终从最新极值起算（与手动分析口径一致）。
 */
function identifyLeg(klines: KlineData[], currentPrice: number): Leg | null {
  const seg = klines.slice(-90); // 约 15 天的 4h，覆盖近期主结构
  if (seg.length < 20) return null;

  const { points, dir, pendingExtreme } = zigzag(seg, 0.04);
  if (!dir || points.length === 0) return null;

  const last = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;

  let direction: 'up' | 'down' | null = null;
  let base = 0;
  let extreme = 0;
  let startTime = 0;
  let endTime = 0;

  if (dir === 'down') {
    // 正从高点回落：本腿是上涨腿
    if (last.type === 'H' && prev && prev.type === 'L') {
      // 标准回调：L → H 已确认
      direction = 'up';
      base = prev.price;
      extreme = Math.max(last.price, pendingExtreme);
      startTime = prev.time;
      endTime = last.time;
    } else if (last.type === 'L' && prev && prev.type === 'H') {
      // 下跌腿延续中（L 确认后又创新低）：H → 追踪低点
      direction = 'down';
      base = prev.price;
      extreme = Math.min(last.price, pendingExtreme);
      startTime = prev.time;
      endTime = last.time;
    } else if (last.type === 'H') {
      // H 已确认但前面的 L 不在序列（少见）：H → 追踪低点，下跌腿延续
      direction = 'down';
      base = last.price;
      extreme = pendingExtreme;
      startTime = last.time;
      endTime = last.time;
    }
  } else {
    // dir === 'up'：正从低点反弹
    if (last.type === 'L' && prev && prev.type === 'H') {
      // 标准反弹：H → L 已确认，本腿是下跌腿
      direction = 'down';
      base = prev.price;
      extreme = Math.min(last.price, pendingExtreme);
      startTime = prev.time;
      endTime = last.time;
    } else if (last.type === 'H' && prev && prev.type === 'L') {
      // 上涨腿延续中（H 确认后又创新高）
      direction = 'up';
      base = prev.price;
      extreme = Math.max(last.price, pendingExtreme);
      startTime = prev.time;
      endTime = last.time;
    } else if (last.type === 'L') {
      // 上涨腿形成中（L 已确认，高点未确认）：L → 追踪高点
      direction = 'up';
      base = last.price;
      extreme = pendingExtreme;
      startTime = last.time;
      endTime = last.time;
    }
  }

  if (!direction || !base || !extreme) return null;

  const legSize = Math.abs(extreme - base);
  if (legSize / base < 0.03) return null;

  const retracement =
    direction === 'up'
      ? (extreme - currentPrice) / legSize
      : (currentPrice - extreme) / legSize;

  const fibRetracements = [0.236, 0.382, 0.5, 0.618, 0.786].map((r) => ({
    ratio: r,
    price: direction === 'up' ? extreme - legSize * r : extreme + legSize * r,
  }));
  const fibExtensions = [1.272, 1.618].map((r) => ({
    ratio: r,
    price: base + legSize * r * (direction === 'up' ? 1 : -1),
  }));

  return {
    direction,
    startPrice: base,
    startTime,
    endPrice: extreme,
    endTime,
    range: legSize,
    rangePct: Math.round((legSize / base) * 1000) / 10,
    retracement: Math.round(retracement * 1000) / 1000,
    fibRetracements,
    fibExtensions,
  };
}

// ==================== 关键位体系 ====================

export interface KeyLevel {
  price: number;
  label: string;
  /** 该位到当前价的距离（正=在上方，负=在下方） */
  distancePct: number;
}

/** 大区间江恩八分位（近 120 根 4h 的显著高低，贴近当前结构） */
function gannEighths(klines: KlineData[], currentPrice: number): { price: number; label: string }[] {
  const seg = klines.slice(-120);
  const hi = Math.max(...seg.map((k) => k.high));
  const lo = Math.min(...seg.map((k) => k.low));
  const range = hi - lo;
  const names = ['1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8'];
  const out: { price: number; label: string }[] = [];
  for (let i = 1; i <= 7; i++) {
    out.push({ price: lo + (range * i) / 8, label: `江恩${names[i - 1]}` });
  }
  void currentPrice;
  return out;
}

/** 成交密集区（近 120 根 4h 量能分布前 3 档） */
function volumeNodes(klines: KlineData[]): { price: number; volume: number }[] {
  const seg = klines.slice(-120);
  const hi = Math.max(...seg.map((k) => k.high));
  const lo = Math.min(...seg.map((k) => k.low));
  const step = Math.max((hi - lo) / 24, lo * 0.0005); // 自适应档位
  const buckets = new Map<number, number>();
  for (const k of seg) {
    const mid = (k.high + k.low) / 2;
    const key = Math.round(mid / step) * step;
    buckets.set(key, (buckets.get(key) || 0) + k.volume);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([price, volume]) => ({ price: Math.round(price * 100) / 100, volume }));
}

// ==================== 微观结构位（流动性池 + FVG） ====================

/** 未扫流动性池：等高/等低点对形成的止损簇（价格倾向先扫荡再反转） */
export interface LiquidityPool {
  /** 池位（等高点取较高者 / 等低点取较低者） */
  price: number;
  /** 等高点池（上方止损簇） / 等低点池（下方止损簇） */
  side: 'high' | 'low';
  /** 池形成时间（第二个端点） */
  formedAt: number;
  /** 第一个端点时间（前端画等高/等低两点连线用） */
  firstAt: number;
  /** 距当前价百分比（正=上方） */
  distancePct: number;
}

/**
 * 等高/等低点对 → 流动性池
 * 判定：两摆动点价差 < 0.3%，间隔 >= 8 根；第二端点确认后至今池位未被扫过（未破=池子还在）
 * 实测口径（ETH/BTC/SOL 4h×4000 根走查回放，2024-10~2026-08，n≈3000）：
 * 30 根内触及率 32%，60 根 41%，90 根 49% —— 池是中期参考位，不是短期必达位
 */
function findLiquidityPools(klines: KlineData[], currentPrice: number): LiquidityPool[] {
  const seg = klines.slice(-120);
  if (seg.length < 30 || currentPrice <= 0) return [];
  const { highs, lows } = findSwings(seg);
  const tol = 0.003;
  const pools: LiquidityPool[] = [];

  const scan = (pts: { index: number; price: number }[], side: 'high' | 'low') => {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        if (b.index - a.index < 8) continue; // 间隔太近不算独立池
        if (Math.abs(a.price - b.price) / a.price > tol) continue;
        const pool = side === 'high' ? Math.max(a.price, b.price) : Math.min(a.price, b.price);
        const confirmIdx = b.index + 3; // 摆动点右侧 3 根确认后才能"看到"这个池
        if (confirmIdx >= seg.length - 1) continue;
        // 池位必须尚未被扫（从确认点到现在都没触及）
        let swept = false;
        for (let t = confirmIdx; t < seg.length; t++) {
          if (side === 'high' ? seg[t].high >= pool : seg[t].low <= pool) {
            swept = true;
            break;
          }
        }
        if (swept) continue;
        pools.push({
          price: roundPrice(pool),
          side,
          formedAt: seg[b.index].time,
          firstAt: seg[a.index].time,
          distancePct: Math.round(((pool - currentPrice) / currentPrice) * 1000) / 10,
        });
      }
    }
  };
  scan(highs, 'high');
  scan(lows, 'low');

  // 同价位附近多个池只留一个（0.4% 内合并），按距现价由近到远取前 4
  const out: LiquidityPool[] = [];
  for (const p of pools.sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct))) {
    if (!out.some((o) => Math.abs(o.price - p.price) / currentPrice < 0.004)) out.push(p);
    if (out.length >= 4) break;
  }
  return out;
}

/** 未回补 FVG 缺口（三K失衡区，50% CE 位为回补目标） */
export interface FairValueGap {
  /** 缺口下沿 */
  low: number;
  /** 缺口上沿 */
  high: number;
  /** 50% 回补位（CE, Consequent Encroachment） */
  ce: number;
  /** 上缺口（多头失衡） / 下缺口（空头失衡） */
  dir: 'bull' | 'bear';
  /** 形成时间 */
  formedAt: number;
  /** CE 距当前价百分比（正=上方） */
  distancePct: number;
}

/**
 * 三K失衡缺口 → FVG
 * 判定：K1.high < K3.low（上缺口）或 K1.low > K3.high（下缺口），宽 >= 0.15×ATR，且 CE 至今未被触及
 * 实测口径（ETH/BTC/SOL 4h×4000 根走查回放，2024-10~2026-08，n≈5900）：
 * 30 根内 CE 回补率 38%，60 根 48%，90 根 54%，180 根 61% —— 是有效的中期目标位，
 * 但并非"必达"，使用时按触及概率折算而非当作确定事件
 */
function findFairValueGaps(klines: KlineData[], currentPrice: number, atrValue: number): FairValueGap[] {
  const seg = klines.slice(-90);
  if (seg.length < 10 || currentPrice <= 0) return [];
  const minWidth = Math.max(atrValue * 0.15, currentPrice * 0.0008);
  const out: FairValueGap[] = [];

  for (let i = 2; i < seg.length; i++) {
    const k1 = seg[i - 2];
    const k3 = seg[i];
    const bull = k1.high < k3.low; // 上缺口：K1 最高 < K3 最低
    const bear = k1.low > k3.high; // 下缺口：K1 最低 > K3 最高
    if (!bull && !bear) continue;
    const gapLow = bull ? k1.high : k3.high;
    const gapHigh = bull ? k3.low : k1.low;
    if (gapHigh - gapLow < minWidth) continue;
    const ce = (gapLow + gapHigh) / 2;
    // CE 必须尚未回补（从形成后到现在都没触及）
    let filled = false;
    for (let t = i + 1; t < seg.length; t++) {
      if (seg[t].low <= ce && seg[t].high >= ce) {
        filled = true;
        break;
      }
    }
    if (filled) continue;
    out.push({
      low: roundPrice(gapLow),
      high: roundPrice(gapHigh),
      ce: roundPrice(ce),
      dir: bull ? 'bull' : 'bear',
      formedAt: k3.time,
      distancePct: Math.round(((ce - currentPrice) / currentPrice) * 1000) / 10,
    });
  }

  // 按距现价由近到远取前 4
  return out.sort((x, y) => Math.abs(x.distancePct) - Math.abs(y.distancePct)).slice(0, 4);
}

// ==================== 利润测算（多方法汇流） ====================

/** 概率估算的展望窗口：30 根 4h（约 5 天） */
const PROB_BARS = 30;

export interface ProfitTarget {
  /** 方法标识（measured-move / fib-1272 / ...） */
  method: string;
  /** 中文标签（等距测量 / 1.272 扩展 / ...） */
  label: string;
  price: number;
  /** 自现价起 N 根 4h 内触及的估算概率（0-100） */
  probabilityPct: number;
}

export interface ConfluenceZone {
  low: number;
  high: number;
  mid: number;
  /** 叠加出该区的方法标签 */
  methods: string[];
  /** 自现价触及近侧边缘的估算概率（0-100） */
  probabilityPct: number;
}

/** ATR(14)：平均真实波幅 */
function atr(klines: KlineData[], period = 14): number {
  if (klines.length < period + 1) return 0;
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const prevClose = klines[i - 1].close;
    const tr = Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - prevClose),
      Math.abs(klines[i].low - prevClose),
    );
    sum += tr;
  }
  return sum / period;
}

/** 标准正态 CDF（Zelen & Severo 近似，误差 < 7.5e-8） */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/**
 * 触及概率经验校准表（30 根 4h 窗口）
 *
 * 数据来源：ETH/BTC/SOL USDT 4h×4000 根（2024-10 ~ 2026-08）走查回放，
 * 16,606 个利润测算目标位样本，按归一化距离 d=|ln(T/P)|/(σ√30) 分桶统计
 * 实际 30 根内触及率，再做加权等渗回归（保证单调不增）。
 * 表项 [d0, rate] 为 [d0, d0+0.1) 桶的平均触及率（查表取桶中点插值，见 lookupCalib）。
 *
 * 为何不用理论公式：原反射原理公式 2·(1-Φ(d)) 假设零漂移随机游走，
 * 实测系统性高估 15~30 个百分点（d=0.5 处声称 62%、实际 39.5%；
 * d=1.0 处声称 31%、实际 13.8%）——趋势市的持续性与均值回复让
 * 远目标的真实触及率远低于理论值。此表为实测值，无模型假设。
 */
const TOUCH_CALIB: [number, number][] = [
  [0.0, 0.903], // n=827
  [0.1, 0.810], // n=1837
  [0.2, 0.676], // n=1704
  [0.3, 0.584], // n=1386
  [0.4, 0.476], // n=1310
  [0.5, 0.395], // n=1271
  [0.6, 0.285], // n=1163
  [0.7, 0.262], // n=1083
  [0.8, 0.212], // n=960
  [0.9, 0.186], // n=885
  [1.0, 0.138], // n=741
  [1.1, 0.103], // n=669
  [1.2, 0.100], // n=521
  [1.3, 0.087], // n=772
  [1.5, 0.064], // n=280
  [1.6, 0.064], // n=234
  [1.7, 0.049], // n=432
];

/**
 * 自锚定价起 30 根 4h 内触及目标的概率（经验校准值，0-1）
 * d 为按 ATR 归一化的对数距离；仅校准于 PROB_BARS=30 窗口
 */
function touchProbability(anchorPrice: number, target: number, sigmaPerBar: number, bars: number): number {
  if (anchorPrice <= 0 || target <= 0 || sigmaPerBar <= 0 || bars <= 0) return 0;
  const d = Math.abs(Math.log(target / anchorPrice)) / (sigmaPerBar * Math.sqrt(bars));
  return lookupCalib(TOUCH_CALIB, d, 0.1); // 0.1 宽分桶拟合
}

/**
 * TP 触及概率校准表 —— 分入场情境（同样距离下两种情境的实际触及率差近一倍）
 *
 * 数据来源与 TOUCH_CALIB 同批走查回放，但按预案实际用法条件化：
 *   A 回调入场：价格回踩触及入场位后，出现止跌确认K线（收盘回到入场位有利侧）起算
 *   B 突破回踩：突破触及→回踩触及→站稳确认K线起算（对齐"突破后回踩不破"触发说明）
 * 确认K线为 4h 级别对"15m 止跌结构"的近似代理。
 * 样本：A n=2644 / B n=2028；样本外（时间切分后30%）验证偏差 A +7.7pp / B +1.5pp。
 * 表项 [d0, rate] 为 [d0, d0+0.15) 桶的平均触及率（查表取桶中点插值，见 lookupCalib）。
 */
const TP_CALIB_PULLBACK: [number, number][] = [
  [0.0, 0.904], // n=240
  [0.15, 0.796], // n=554
  [0.3, 0.588], // n=643
  [0.45, 0.468], // n=457
  [0.6, 0.333], // n=303
  [0.75, 0.293], // n=184
  [0.9, 0.202], // n=129
  [1.05, 0.174], // n=69
];
const TP_CALIB_BREAKOUT: [number, number][] = [
  [0.0, 0.953], // n=779
  [0.15, 0.862], // n=651
  [0.3, 0.745], // n=282
  [0.45, 0.514], // n=142
  [0.6, 0.278], // n=79
];

/**
 * 校准表查表（线性插值）。
 *
 * 表项 [d0, rate] 是分桶统计的"桶内平均触及率"（桶区间 [d0, d0+step)），
 * 不是 d0 单点的率 —— 所以插值节点取桶中点（d0 + step/2），而不是左端点。
 * 若直接在左端点上插值，桶内样本会被系统性拉向下一桶的低率，整体压低预测
 * （回放检验：A 情境预测均值偏差 -6.8pp、B 情境 -3.3pp，改中点插值后
 * 分别收敛到 -1.1pp / +2.6pp，Brier 同步下降）。
 * 表外：d 小于首桶中点取首值，超过末桶中点取末值。
 */
function lookupCalib(table: [number, number][], d: number, step: number): number {
  if (table.length === 0) return 0;
  const mid = (i: number) => table[i][0] + step / 2;
  if (d <= mid(0)) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (d <= mid(i)) {
      const p0 = table[i - 1][1];
      const p1 = table[i][1];
      const w = (d - mid(i - 1)) / (mid(i) - mid(i - 1));
      return p0 + w * (p1 - p0);
    }
  }
  return table[table.length - 1][1];
}

/**
 * 自入场价起 30 根 4h 内触及 TP 的概率（按入场情境查对应校准表，0-1）
 * ctx: 'pullback'=A回调确认入场 / 'breakout'=B突破回踩确认入场
 */
function tpProbability(entry: number, tp: number, sigmaPerBar: number, bars: number, ctx: 'pullback' | 'breakout'): number {
  if (entry <= 0 || tp <= 0 || sigmaPerBar <= 0 || bars <= 0) return 0;
  const d = Math.abs(Math.log(tp / entry)) / (sigmaPerBar * Math.sqrt(bars));
  return lookupCalib(ctx === 'pullback' ? TP_CALIB_PULLBACK : TP_CALIB_BREAKOUT, d, 0.15); // 0.15 宽分桶拟合
}

/**
 * A 方案"持仓窗口竞速"校准表 —— 入场确认后，各时间窗口内 TP1/止损 谁先被触及。
 *
 * 与 TP 触及概率的本质区别：触及口径包含"先扫损后又到 TP"的路径，
 * 对实际挂单交易者无意义；本表为 15m 精度逐根竞速（同根双触按先止损保守计），
 * 并按持仓时长分窗口 —— 持仓几小时与持仓几天的真实胜率完全不同。
 * ρ = TP1距离/止损距离（对数距离比）：ρ 小 = TP 比止损近 → 先到止盈率高。
 *
 * 数据来源：ETH/BTC/SOL 4h 信号 × 15m 精度回放（2024-10~2026-08），A 情境
 * （回踩触及+止跌确认K线起算）n=1399。TP1 表用单调不增 PAVA、SL 表单调不降。
 * 样本外验证（时间后30%，ETH n=153，2026-02~07）：
 *   先到止损列最可靠（120h 偏差 0.1pp）；先到止盈列偏差 -2~-8pp（近期行情偏快，
 *   全量表已含近期数据可部分吸收）；6h/12h 短窗口对行情机制最敏感（±10pp 量级）。
 *
 * 注意：B 方案（突破回踩）不提供此概率 —— 其先到止损率随行情机制漂移剧烈
 * （全期 21% vs 2026 年以来 35%），无法稳定校准，宁缺毋滥。
 */
const WINDOW_RACE_HOURS = [6, 12, 24, 72, 120] as const;

export interface WindowRaceRow {
  /** 持仓窗口（小时） */
  hours: number;
  /** 窗口内 TP1 先于止损被触及的概率（0-100） */
  tp1FirstPct: number;
  /** 窗口内止损先于 TP1 被触及的概率（0-100） */
  slFirstPct: number;
  /** 窗口内两者都未触及（挂单仍浮沉）的概率（0-100） */
  unresolvedPct: number;
}

/** 各窗口 TP1 先到率（ρ → 概率，单调不增 PAVA，0.25 步长桶；首桶为 ρ∈[0,0.25)） */
const RACE_TP1: Record<number, [number, number][]> = {
  6: [[0, 0.5], [0.25, 0.401], [0.75, 0.153], [1.5, 0.144], [1.75, 0.067]],
  12: [[0, 0.66], [0.25, 0.504], [0.75, 0.247], [1, 0.225], [1.75, 0.138]],
  24: [[0, 0.72], [0.25, 0.619], [0.75, 0.471], [1, 0.362], [1.5, 0.295], [1.75, 0.23]],
  72: [[0, 0.92], [0.25, 0.73], [0.75, 0.576], [1, 0.538], [1.5, 0.442], [1.75, 0.383]],
  120: [[0, 0.92], [0.25, 0.752], [0.75, 0.647], [1, 0.569], [1.5, 0.457], [1.75, 0.446]],
};

/** 各窗口止损先到率（ρ → 概率，单调不降 PAVA，0.25 步长桶） */
const RACE_SL: Record<number, [number, number][]> = {
  6: [[0.25, 0.025], [0.5, 0.042], [1.25, 0.081]],
  12: [[0.25, 0.051], [0.5, 0.066], [1, 0.161], [1.25, 0.162], [1.5, 0.174]],
  24: [[0.25, 0.085], [0.5, 0.122], [1, 0.194], [1.25, 0.279], [1.5, 0.302]],
  72: [[0.25, 0.161], [0.5, 0.2], [0.75, 0.306], [1, 0.371], [1.25, 0.397], [1.5, 0.472]],
  120: [[0.25, 0.178], [0.5, 0.221], [0.75, 0.329], [1, 0.403], [1.25, 0.412], [1.5, 0.516]],
};

/**
 * A 方案各持仓窗口的竞速概率分布（按预案的 ρ 查表）
 * 未触及 = 1 - 先到TP1 - 先到止损（截断至 ≥0；各桶实测未决率与该恒等式一致，±6pp 内）
 */
function windowRaceOutcomes(entry: number, tp1: number, stop: number): WindowRaceRow[] {
  if (entry <= 0 || tp1 <= 0 || stop <= 0) return [];
  const dTp = Math.abs(Math.log(tp1 / entry));
  const dSl = Math.abs(Math.log(stop / entry));
  if (dSl <= 0) return [];
  const rho = dTp / dSl;
  return WINDOW_RACE_HOURS.map((h) => {
    const tp = lookupCalib(RACE_TP1[h], rho, 0.25);
    const sl = lookupCalib(RACE_SL[h], rho, 0.25);
    const unresolved = Math.max(0, 1 - tp - sl);
    // 归一化到 100%（未决截断产生的微量误差并入未决列之外的两列按比例分摊）
    const sum = tp + sl;
    const k = sum > 0 ? (1 - unresolved) / sum : 0;
    // 先取整前两列，未触及列 = 100 - 两者，保证三列显示合计恒为 100
    let tpPct = Math.round(tp * k * 100);
    let slPct = Math.round(sl * k * 100);
    let unPct = 100 - tpPct - slPct;
    if (unPct < 0) {
      // 极端双进位：从较大列扣回，保持合计 100 且未触及不为负
      if (tpPct >= slPct) tpPct += unPct;
      else slPct += unPct;
      unPct = 0;
    }
    return {
      hours: h,
      tp1FirstPct: tpPct,
      slFirstPct: slPct,
      unresolvedPct: unPct,
    };
  });
}

/** 取方向侧最近的一个位（dir=1 上方 / -1 下方，限制最大距离） */
function nearestInDirection(
  levels: { price: number; label: string }[],
  currentPrice: number,
  dir: 1 | -1,
  maxDistPct: number,
): { price: number; label: string } | null {
  const maxDist = currentPrice * maxDistPct;
  const filtered = levels.filter((l) => {
    const d = (l.price - currentPrice) * dir;
    return d > currentPrice * 0.005 && d <= maxDist;
  });
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => (a.price - b.price) * dir);
  return filtered[0];
}

/** 目标位聚类：价差 <= 0.8% 现价的相邻目标归为一区，≥2 个不同方法才成汇流区 */
function clusterTargets(
  targets: ProfitTarget[],
  currentPrice: number,
  dirSign: 1 | -1,
  sigmaPerBar: number,
): ConfluenceZone[] {
  if (targets.length === 0) return [];
  const tol = currentPrice * 0.008;
  const sorted = [...targets].sort((a, b) => a.price - b.price);
  const zones: ConfluenceZone[] = [];

  const makeZone = (group: ProfitTarget[]): ConfluenceZone => {
    const prices = group.map((g) => g.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    return {
      low: roundPrice(low),
      high: roundPrice(high),
      mid: roundPrice((low + high) / 2),
      methods: group.map((g) => g.label),
      // 触及概率按近侧边缘算（上方区间的 low / 下方区间的 high）
      probabilityPct: Math.round(touchProbability(currentPrice, dirSign === 1 ? low : high, sigmaPerBar, PROB_BARS) * 100),
    };
  };

  let group: ProfitTarget[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price - group[group.length - 1].price <= tol) {
      group.push(sorted[i]);
    } else {
      if (group.length >= 2) zones.push(makeZone(group));
      group = [sorted[i]];
    }
  }
  if (group.length >= 2) zones.push(makeZone(group));
  return zones;
}

// ==================== 预案生成 ====================

export interface TradePlan {
  id: 'A' | 'B';
  name: string;
  side: 'long' | 'short';
  /** 触发条件描述 */
  trigger: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  /** 风险（价格距离） */
  risk: number;
  riskPct: number;
  rrTp1: number;
  rrTp2: number;
  /** 半仓 TP1 + 半仓 TP2 的加权盈亏比 */
  rrBlended: number;
  /** TP2 的依据（如 "等距测量 + 1.272 扩展 汇流"），无汇流时缺省 */
  tp2Source?: string;
  /** 自入场价起 N 根 4h 内触及 TP1 的估算概率（0-100） */
  tp1ProbabilityPct?: number;
  /** 自入场价起 N 根 4h 内触及 TP2 的估算概率（0-100） */
  tp2ProbabilityPct?: number;
  /**
   * 入场确认后 120h（=30根4h）内：TP1 先于止损被触及的概率（0-100，实测"先到"口径）
   * 取自 windowRace 末行；仅 A 方案提供（B 方案无法稳定校准，见 RACE 表注释）
   */
  tp1FirstPct?: number;
  /** 入场确认后 120h 内：止损先于 TP1 被触及的概率（0-100，实测"先到"口径），仅 A 方案 */
  slFirstPct?: number;
  /**
   * 分持仓窗口的竞速概率分布（6/12/24/72/120h），仅 A 方案。
   * 持仓多久看哪行：短窗口大量"未决"（价格还没走到任何一边），不是胜率低。
   */
  windowRace?: WindowRaceRow[];
  /** 触发概率主观标记：high=回调类（结构内），medium=突破类（需动能确认） */
  confidence: 'high' | 'medium';
}

function roundPrice(p: number): number {
  if (p >= 1000) return Math.round(p * 10) / 10;
  if (p >= 1) return Math.round(p * 100) / 100;
  return Math.round(p * 100000) / 100000;
}

function buildPlan(
  id: 'A' | 'B',
  name: string,
  side: 'long' | 'short',
  trigger: string,
  entry: number,
  stop: number,
  tp1: number,
  tp2: number,
  confidence: 'high' | 'medium',
  extras?: {
    tp2Source?: string;
    tp1ProbabilityPct?: number;
    tp2ProbabilityPct?: number;
    tp1FirstPct?: number;
    slFirstPct?: number;
    windowRace?: WindowRaceRow[];
  },
): TradePlan {
  const risk = Math.abs(entry - stop);
  const rrTp1 = Math.abs(tp1 - entry) / risk;
  const rrTp2 = Math.abs(tp2 - entry) / risk;
  return {
    id,
    name,
    side,
    trigger,
    entry: roundPrice(entry),
    stop: roundPrice(stop),
    tp1: roundPrice(tp1),
    tp2: roundPrice(tp2),
    risk: roundPrice(risk),
    riskPct: Math.round((risk / entry) * 1000) / 10,
    rrTp1: Math.round(rrTp1 * 100) / 100,
    rrTp2: Math.round(rrTp2 * 100) / 100,
    rrBlended: Math.round(((rrTp1 + rrTp2) / 2) * 100) / 100,
    tp2Source: extras?.tp2Source,
    tp1ProbabilityPct: extras?.tp1ProbabilityPct,
    tp2ProbabilityPct: extras?.tp2ProbabilityPct,
    tp1FirstPct: extras?.tp1FirstPct,
    slFirstPct: extras?.slFirstPct,
    windowRace: extras?.windowRace,
    confidence,
  };
}

// ==================== 主入口 ====================

export interface StructureAnalysis {
  symbol: string;
  generatedAt: number;
  currentPrice: number;
  /** 三周期趋势 */
  periods: {
    '4h': PeriodTrend;
    '1h': PeriodTrend;
    '15m': PeriodTrend;
  };
  /** 共振计数：多 - 空 */
  resonance: number;
  resonanceText: string;
  /** 本腿 */
  leg: Leg | null;
  /** A/B 双预案（leg 为 null 时可能为空） */
  plans: TradePlan[];
  /** 结构失效位（跌破/升破则当前预案作废） */
  invalidation: { price: number; note: string } | null;
  /** 关键位（含距离标注） */
  keyLevels: KeyLevel[];
  /** 成交密集区 */
  volumeNodes: { price: number; volume: number }[];
  /** 利润测算目标位（多方法投影 + 估算触及概率） */
  profitTargets: ProfitTarget[];
  /** 主汇流止盈区（2+ 方法重叠，方向侧离入场最近），无则 null */
  confluence: ConfluenceZone | null;
  /** 延伸目标（汇流区之外最远投影），无则 null */
  extendedTarget: ProfitTarget | null;
  /** 未扫流动性池（等高/等低点止损簇，扫荡目标位），独立于本腿 */
  liquidityPools: LiquidityPool[];
  /** 未回补 FVG 缺口（50% CE 回补目标位），独立于本腿 */
  fairValueGaps: FairValueGap[];
  /** AB=CD 时间对称的到达时间窗 */
  eta: { bars: number; text: string } | null;
  /** 4h ATR(14) */
  atr: number;
  /** 规则引擎的定性结论（AI 与模板共用） */
  bias: 'bull' | 'bear' | 'neutral';
  biasText: string;
}

export interface StructureInput {
  symbol: string;
  k4h: KlineData[];
  k1h: KlineData[];
  k15m: KlineData[];
}

/**
 * 结构共振分析主函数
 * 输入三周期 K 线，输出完整结构数据（确定性，无随机性）
 */
export function analyzeStructure(input: StructureInput): StructureAnalysis {
  const { symbol, k4h, k1h, k15m } = input;
  const currentPrice = k4h.length > 0 ? k4h[k4h.length - 1].close : 0;

  const t4h = calcPeriodTrend(k4h);
  const t1h = calcPeriodTrend(k1h);
  const t15m = calcPeriodTrend(k15m);

  const bullCount = [t4h, t1h, t15m].filter((t) => t.dir === 'bull').length;
  const bearCount = [t4h, t1h, t15m].filter((t) => t.dir === 'bear').length;
  const resonance = bullCount - bearCount;
  const resonanceText = `多 ${bullCount} / 空 ${bearCount} / 震荡 ${3 - bullCount - bearCount}`;

  const leg = identifyLeg(k4h, currentPrice);

  // ---------- 利润测算（多方法投影 + 汇流聚类） ----------
  const vNodes = volumeNodes(k4h);
  const gannLevels = gannEighths(k4h, currentPrice);
  const atrValue = atr(k4h);

  // ---------- 微观结构位（流动性池 + FVG，独立于本腿识别，供画线与目标位参考） ----------
  const liquidityPools = findLiquidityPools(k4h, currentPrice);
  const fairValueGaps = findFairValueGaps(k4h, currentPrice, atrValue);

  const sigmaPerBar = currentPrice > 0 ? atrValue / currentPrice : 0;
  const probFrom = (anchor: number, tp: number) => Math.round(touchProbability(anchor, tp, sigmaPerBar, PROB_BARS) * 100);
  // 预案 TP 概率：按入场情境查对应校准表（A=回调确认 / B=突破回踩确认）
  const tpProbFrom = (entry: number, tp: number, ctx: 'pullback' | 'breakout') =>
    Math.round(tpProbability(entry, tp, sigmaPerBar, PROB_BARS, ctx) * 100);
  // A 方案"先到"口径概率（TP1 与止损逐根竞速，仅 A 情境有校准表）：
  // 分持仓窗口分布 + 兼容字段（tp1FirstPct/slFirstPct 取 120h 行）
  const raceExtras = (entry: number, tp1: number, stop: number) => {
    const rows = windowRaceOutcomes(entry, tp1, stop);
    const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
    return {
      windowRace: rows.length > 0 ? rows : undefined,
      tp1FirstPct: last?.tp1FirstPct,
      slFirstPct: last?.slFirstPct,
    };
  };

  let profitTargets: ProfitTarget[] = [];
  let confluence: ConfluenceZone | null = null;
  let extendedTarget: ProfitTarget | null = null;
  let eta: { bars: number; text: string } | null = null;

  // ---------- 预案 ----------
  const plans: TradePlan[] = [];
  let invalidation: { price: number; note: string } | null = null;

  if (leg) {
    const fib = (r: number) => leg.fibRetracements.find((f) => f.ratio === r)!.price;
    const ext = (r: number) => leg.fibExtensions.find((f) => f.ratio === r)!.price;
    const { highs, lows } = findSwings(k4h.slice(-60));

    const isUp = leg.direction === 'up';
    const dirSign: 1 | -1 = isUp ? 1 : -1;

    // ---- 1. 各方法独立投影目标位 ----
    const candidates: ProfitTarget[] = [];
    const pushTarget = (method: string, label: string, price: number) => {
      candidates.push({
        method,
        label,
        price: roundPrice(price),
        probabilityPct: probFrom(currentPrice, price),
      });
    };

    // 等距测量（Measured Move）：目标 = 回调锚 C + |AB|
    pushTarget('measured-move', '等距测量', fib(0.618) + dirSign * leg.range);
    // 斐波那契扩展
    pushTarget('fib-1272', '1.272 扩展', ext(1.272));
    pushTarget('fib-1618', '1.618 扩展', ext(1.618));
    // 前高/前低结构位
    pushTarget('structure', isUp ? '前高结构位' : '前低结构位', leg.endPrice);
    // 成交密集区（方向侧最近一档）
    const vn = nearestInDirection(vNodes.map((v) => ({ price: v.price, label: '成交密集区' })), currentPrice, dirSign, 0.15);
    if (vn) pushTarget('volume-node', '成交密集区', vn.price);
    // 江恩八分位（方向侧最近一档）
    const gn = nearestInDirection(gannLevels, currentPrice, dirSign, 0.15);
    if (gn) pushTarget('gann', gn.label, gn.price);
    // 流动性池（方向侧最近一个未扫池：止损簇扫荡位，实测30根触及率约32%，中期参考位）
    const pool = liquidityPools
      .filter((p) => (p.price - currentPrice) * dirSign > currentPrice * 0.005)
      .sort((a, b) => (a.price - b.price) * dirSign)[0];
    if (pool) pushTarget('liquidity', `流动性池·${pool.side === 'high' ? '等高' : '等低'}`, pool.price);
    // FVG 50% 回补位（方向侧最近一个未回补缺口，实测30根回补率约38%，中期参考位）
    const fvg = fairValueGaps
      .filter((f) => (f.ce - currentPrice) * dirSign > currentPrice * 0.005)
      .sort((a, b) => (a.ce - b.ce) * dirSign)[0];
    if (fvg) pushTarget('fvg', 'FVG 50%回补', fvg.ce);

    // 只保留方向侧、离现价有意义（>0.5%）的目标
    profitTargets = candidates.filter((t) => (t.price - currentPrice) * dirSign > currentPrice * 0.005);

    // ---- 2. 汇流聚类（≥2 方法重叠才算） ----
    const zones = clusterTargets(profitTargets, currentPrice, dirSign, sigmaPerBar);
    const entryA = fib(0.618);
    // 主汇流区：入场之外方向侧最近的区
    const beyondEntry = zones.filter((z) =>
      dirSign === 1 ? z.low > entryA + currentPrice * 0.003 : z.high < entryA - currentPrice * 0.003,
    );
    const zoneA = beyondEntry.length > 0 ? beyondEntry[0] : null;
    confluence = zoneA;

    // 延伸目标：主汇流区之外最远的投影
    if (zoneA) {
      const beyond = profitTargets.filter((t) => (t.price - zoneA.high) * dirSign > 0);
      const pool = beyond.length > 0 ? beyond : profitTargets;
      extendedTarget = pool.reduce((far, t) => ((t.price - far.price) * dirSign > 0 ? t : far), pool[0]);
    }

    // ---- 3. AB=CD 时间对称（到达时间窗估算） ----
    if (leg.endTime > leg.startTime) {
      const bars = Math.round((leg.endTime - leg.startTime) / 14400); // 4h = 14400s
      if (bars >= 2) {
        eta = { bars, text: `AB=CD 时间对称：D 点预计 ≈ ${Math.max(1, Math.round((bars * 4) / 24))} 天内到达` };
      }
    }

    if (isUp) {
      // ---- 上涨腿：回调做多 + 突破做多 ----
      const swingLow = lows.length > 0 ? lows[lows.length - 1].price : fib(0.786);
      const stopA = Math.min(fib(0.786), swingLow) * 0.996; // 结构位下方留 0.4% 缓冲
      // TP1 = 23.6% 回撤位（entry 上方第一阻力）；若离 entry 太近（盈亏比<1）取 entry~端点中间
      let tp1A = fib(0.236);
      if ((tp1A - entryA) / (entryA - stopA) < 1) tp1A = entryA + (leg.endPrice - entryA) / 2;
      // TP2：主汇流区中值优先（多方法重叠，置信度高于单一结构位）
      let tp2A = leg.endPrice;
      let tp2SourceA: string | undefined;
      if (zoneA && zoneA.mid > tp1A) {
        tp2A = zoneA.mid;
        tp2SourceA = `${zoneA.methods.join(' + ')} 汇流`;
      }
      plans.push(
        buildPlan('A', '回调做多（首选）', 'long', `回踩 ${roundPrice(entryA)} 需求区（推动腿 61.8% 回撤），15m 出现止跌结构后入场`, entryA, stopA, tp1A, tp2A, 'high', {
          tp2Source: tp2SourceA,
          tp1ProbabilityPct: tpProbFrom(entryA, tp1A, 'pullback'),
          tp2ProbabilityPct: tpProbFrom(entryA, tp2A, 'pullback'),
          ...raceExtras(entryA, tp1A, stopA),
        }),
      );
      const entryB = leg.endPrice * 1.005; // 突破前高后回踩
      const stopB = leg.endPrice * 0.988; // 突破点下方 1.2% 缓冲
      // B 单目标：突破后先看主汇流区（若在突破位上方），延伸档看最远投影
      const zoneB = zones.find((z) => z.low > entryB);
      const tp1B = zoneB ? zoneB.mid : entryB + leg.range * 0.1;
      let tp2B = ext(1.618);
      let tp2SourceB: string | undefined;
      if (extendedTarget && (extendedTarget.price - tp1B) * dirSign > 0) {
        tp2B = extendedTarget.price;
        tp2SourceB = `${extendedTarget.label}（延伸档）`;
      }
      if ((tp2B - tp1B) * dirSign <= 0) tp2B = tp1B + dirSign * leg.range * 0.1;
      plans.push(
        buildPlan('B', '突破追多（备选）', 'long', `1h 放量突破 ${roundPrice(leg.endPrice)} 后回踩不破`, entryB, stopB, tp1B, tp2B, 'medium', {
          tp2Source: tp2SourceB,
          tp1ProbabilityPct: tpProbFrom(entryB, tp1B, 'breakout'),
          tp2ProbabilityPct: tpProbFrom(entryB, tp2B, 'breakout'),
        }),
      );
      invalidation = { price: roundPrice(stopA), note: `4h 收盘跌破 ${roundPrice(stopA)} 则该推动腿结构失效，做多预案作废` };
    } else {
      // ---- 下跌腿：反弹做空 + 跌破追空 ----
      const swingHigh = highs.length > 0 ? highs[highs.length - 1].price : fib(0.786);
      const stopA = Math.max(fib(0.786), swingHigh) * 1.004;
      let tp1A = fib(0.236);
      if ((entryA - tp1A) / (stopA - entryA) < 1) tp1A = entryA - (entryA - leg.endPrice) / 2;
      let tp2A = leg.endPrice;
      let tp2SourceA: string | undefined;
      if (zoneA && zoneA.mid < tp1A) {
        tp2A = zoneA.mid;
        tp2SourceA = `${zoneA.methods.join(' + ')} 汇流`;
      }
      plans.push(
        buildPlan('A', '反弹做空（首选）', 'short', `反弹至 ${roundPrice(entryA)} 供给区（推动腿 61.8% 回撤），15m 出现滞涨结构后入场`, entryA, stopA, tp1A, tp2A, 'high', {
          tp2Source: tp2SourceA,
          tp1ProbabilityPct: tpProbFrom(entryA, tp1A, 'pullback'),
          tp2ProbabilityPct: tpProbFrom(entryA, tp2A, 'pullback'),
          ...raceExtras(entryA, tp1A, stopA),
        }),
      );
      const entryB = leg.endPrice * 0.995;
      const stopB = leg.endPrice * 1.012;
      const zoneB = zones.find((z) => z.high < entryB);
      const tp1B = zoneB ? zoneB.mid : entryB - leg.range * 0.1;
      let tp2B = ext(1.618);
      let tp2SourceB: string | undefined;
      if (extendedTarget && (extendedTarget.price - tp1B) * dirSign > 0) {
        tp2B = extendedTarget.price;
        tp2SourceB = `${extendedTarget.label}（延伸档）`;
      }
      if ((tp2B - tp1B) * dirSign >= 0) tp2B = tp1B - leg.range * 0.1;
      plans.push(
        buildPlan('B', '跌破追空（备选）', 'short', `1h 放量跌破 ${roundPrice(leg.endPrice)} 后反抽不破`, entryB, stopB, tp1B, tp2B, 'medium', {
          tp2Source: tp2SourceB,
          tp1ProbabilityPct: tpProbFrom(entryB, tp1B, 'breakout'),
          tp2ProbabilityPct: tpProbFrom(entryB, tp2B, 'breakout'),
        }),
      );
      invalidation = { price: roundPrice(stopA), note: `4h 收盘升破 ${roundPrice(stopA)} 则该推动腿结构失效，做空预案作废` };
    }
  }

  // ---------- 关键位 ----------
  const rawLevels: { price: number; label: string }[] = [];
  if (leg) {
    rawLevels.push({ price: leg.endPrice, label: '推动腿端点' });
    rawLevels.push({ price: leg.startPrice, label: '推动腿起点' });
    for (const f of leg.fibRetracements) {
      rawLevels.push({ price: f.price, label: `推动腿${Math.round(f.ratio * 100)}%回撤` });
    }
    for (const e of leg.fibExtensions) {
      rawLevels.push({ price: e.price, label: `推动腿${e.ratio}扩展` });
    }
  }
  for (const g of gannLevels) {
    rawLevels.push({ price: g.price, label: g.label });
  }
  // 利润测算目标位 + 汇流区边缘
  for (const t of profitTargets) {
    rawLevels.push({ price: t.price, label: t.label });
  }
  if (confluence) {
    rawLevels.push({ price: confluence.high, label: '汇流区上沿' });
    rawLevels.push({ price: confluence.low, label: '汇流区下沿' });
  }
  // EMA 参考位
  rawLevels.push({ price: t4h.ema20, label: '4h EMA20' });
  rawLevels.push({ price: t4h.ema60, label: '4h EMA60' });
  // 成交密集区（vNodes 已在利润测算段计算）
  for (const v of vNodes) {
    rawLevels.push({ price: v.price, label: '成交密集区' });
  }

  // 去重（5‰ 内合并）+ 距离标注 + 排序，取当前价上方 4 个下方 4 个
  const tol = currentPrice * 0.005;
  const merged: KeyLevel[] = [];
  for (const l of rawLevels) {
    const dup = merged.find((m) => Math.abs(m.price - l.price) < tol);
    if (dup) {
      // 保留更具体的标签（斐波那契/江恩优先于 EMA）
      if (l.label.length < dup.label.length) dup.label = l.label;
    } else {
      merged.push({
        price: roundPrice(l.price),
        label: l.label,
        distancePct: Math.round(((l.price - currentPrice) / currentPrice) * 1000) / 10,
      });
    }
  }
  merged.sort((a, b) => b.price - a.price); // 降序：上方近→远，下方远→近
  // 上方：从现价往上 4 个；下方：从现价往下 4 个（降序数组中 filter 后前 4 个即离现价最近的）
  const above = merged.filter((m) => m.price > currentPrice * 1.002).slice(0, 4);
  const below = merged.filter((m) => m.price < currentPrice * 0.998).slice(0, 4).reverse();
  const keyLevels = [...above, ...below];

  // ---------- 定性 ----------
  let bias: 'bull' | 'bear' | 'neutral' = 'neutral';
  if (resonance >= 2 || (resonance >= 1 && leg && leg.direction === 'up' && leg.retracement < 0.7)) bias = 'bull';
  else if (resonance <= -2 || (resonance <= -1 && leg && leg.direction === 'down' && leg.retracement < 0.7)) bias = 'bear';
  const biasText = bias === 'bull' ? '偏多' : bias === 'bear' ? '偏空' : '中性';

  return {
    symbol,
    generatedAt: Date.now(),
    currentPrice,
    periods: { '4h': t4h, '1h': t1h, '15m': t15m },
    resonance,
    resonanceText,
    leg,
    plans,
    invalidation,
    keyLevels,
    volumeNodes: vNodes,
    profitTargets,
    confluence,
    extendedTarget,
    liquidityPools,
    fairValueGaps,
    eta,
    atr: roundPrice(atrValue),
    bias,
    biasText,
  };
}
