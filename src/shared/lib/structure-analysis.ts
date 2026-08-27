/**
 * 结构共振交易法 · 规则引擎
 *
 * 职责：把三周期 K 线算成结构化分析数据（所有数字都在这里产生）
 * - 三周期趋势判定（4h/1h/15m：EMA20/60 + MACD + 高低点结构）
 * - 本腿识别（最近的显著推动腿）
 * - 斐波那契回撤/扩展 + 江恩八分位 + 成交密集区
 * - D/E 双预案生成（短线点数档 + 波段点数档） + 盈亏比测算 + 失效条件
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

// ==================== 方向信号（实证校准） ====================
//
// 背景：原 bias 规则（三周期共振）经 3,859 个 ETH 4h 信号点回测无预测力
//（|共振|>=2 时 24h 方向命中 42-57%，与抛硬币无异），已不再作为方向依据。
//
// 替代：均值回归极端信号 —— 大趋势（EMA200）中的深度回调：
//   MR分数 = (偏离EMA20% ×10 + 12根动量% ×10 + (RSI14-50)/50) / 3
//   做多：MR ≤ -0.398（前10%超跌）且 价 > EMA200（上升趋势）
//   做空：MR ≥ +0.510（前10%超涨）且 价 < EMA200（下降趋势）
//
// 回测（阈值取前半段训练，后半段样本外验证）：
//   ETH 72h 方向命中：全段 79.2%（n=120）/ 样本外 73.1%（n=26）
//   SOL 迁移验证 72.0%（n=125）；BTC 样本过少（n=13）未验证
//   信号频率约两周一次 —— 大部分时间无信号，这是设计使然（只在极端出手）
//
// 止盈结构（120h 内逐根竞速回测，n=84）：
//   SL=1×ATR，TP1=1.5×ATR 出半仓，TP2=3×ATR 清仓
//   平均 RR +0.46，盈利比 53.6%；紧止盈（0.5×ATR）期望≈0，勿提前止盈

/** 方向信号阈值（ETH 4h 2024-10~2025-09 训练段 10% 分位固化值） */
const MR_LOW = -0.398;
const MR_HIGH = 0.510;

export interface DirectionSignal {
  /** 是否触发（MR 分数到极端 且 与 EMA200 大趋势同向） */
  active: boolean;
  /** 'long' 超跌做多 / 'short' 超涨做空 */
  dir: 'long' | 'short';
  /** 当前 MR 分数（越负越超跌） */
  score: number;
  /** 分数状态描述（触发 / 接近 / 中性） */
  stateText: string;
  /** 距触发还差多少（未触发时给参考，已触发为 0） */
  distanceToTrigger: number;
  /** 大趋势过滤是否通过 */
  trendFilterPassed: boolean;
  /** EMA200 之上=多 / 之下=空 */
  e200Side: 'above' | 'below';
  /** 历史样本外 72h 方向命中率（%），含样本量标注 */
  historyWinRatePct: number;
  /** 胜率的样本与窗口说明（如实标注，不夸大） */
  evidenceText: string;
}

/** RSI14（Wilder 平滑） */
function rsiWilder(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    g += Math.max(d, 0); l += Math.max(-d, 0);
  }
  g /= period; l /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
  }
  return 100 - 100 / (1 + g / (l || 1e-9));
}

/** 方向信号计算（纯函数，输入 4h K线） */
function calcDirectionSignal(k4h: KlineData[], currentPrice: number): DirectionSignal {
  const closes = k4h.map((k) => k.close);
  if (closes.length < 220) {
    return {
      active: false, dir: 'long', score: 0, stateText: '数据不足（需220根4h）',
      distanceToTrigger: 0, trendFilterPassed: false, e200Side: 'above',
      historyWinRatePct: 0, evidenceText: '',
    };
  }
  const e20 = emaSeries(closes, 20);
  const e200 = emaSeries(closes, 200);
  const i = closes.length - 1;
  const dev = (closes[i] - e20[i]) / e20[i];
  const mom = (closes[i] - closes[i - 12]) / closes[i - 12];
  const rs = (rsiWilder(closes) - 50) / 50;
  const score = (dev * 10 + mom * 10 + rs) / 3;

  const aboveE200 = closes[i] > e200[i];
  const e200Side: 'above' | 'below' = aboveE200 ? 'above' : 'below';

  // 多头信号：超跌 + 大趋势向上；空头信号：超涨 + 大趋势向下
  const longActive = score <= MR_LOW && aboveE200;
  const shortActive = score >= MR_HIGH && !aboveE200;
  const active = longActive || shortActive;
  const dir: 'long' | 'short' = longActive ? 'long' : 'short';

  // 未触发时：报告距最近触发阈值的距离（当前趋势侧的阈值）
  const threshold = aboveE200 ? MR_LOW : MR_HIGH;
  const distance = aboveE200 ? score - MR_LOW : MR_HIGH - score;

  let stateText: string;
  if (active) {
    stateText = dir === 'long' ? '已触发·超跌做多' : '已触发·超涨做空';
  } else if (distance < 0.15) {
    stateText = aboveE200 ? '接近超跌买点' : '接近超涨空点';
  } else {
    stateText = '无信号·价格中性';
  }

  return {
    active,
    dir: active ? dir : (aboveE200 ? 'long' : 'short'),
    score: Math.round(score * 1000) / 1000,
    stateText,
    distanceToTrigger: active ? 0 : Math.round(distance * 1000) / 1000,
    trendFilterPassed: aboveE200 ? score <= MR_LOW : score >= MR_HIGH,
    e200Side,
    // ETH 样本外 72h 方向命中（n=26）；SOL 迁移 72%（n=125）；如实标注
    historyWinRatePct: 73,
    evidenceText: 'ETH 4h 样本外验证：信号后72h方向命中 73%（26次/2025-09~2026-08）；SOL迁移72%（125次）；BTC未验证',
  };
}

// ==================== 今日作战计划（无信号时也有方向答案） ====================

export interface PullbackLevel {
  price: number;
  label: string;
  source: 'fib382' | 'fib500' | 'fib618' | 'fib786' | 'key' | 'volume' | 'ema200' | 'pool';
}

export interface DailyPlan {
  /** 今日方向：EMA200 之上=多（等回调低吸），之下=空（等反抽高空） */
  bias: 'long' | 'short';
  /** 方向一句话（交易员口吻） */
  biasText: string;
  /** 回调参考位（方向侧潜在回调目标，按离现价由近到远，最多6个） */
  pullbackLevels: PullbackLevel[];
  /** 最佳进场区：2+ 位重叠聚类（容差0.8%）；无重叠时回落到 fib 0.5–0.618 段 */
  entryZone: { low: number; high: number; mid: number; methods: string[] } | null;
  /** 进场区保护位：区域外沿留 0.6% 缓冲 */
  stopHint: number | null;
  /** 方向失效位（引擎 invalidation，可能为 null） */
  invalidationPrice: number | null;
}

function calcDailyPlan(a: {
  currentPrice: number;
  e200Side: 'above' | 'below';
  leg: Leg | null;
  keyLevels: KeyLevel[];
  volumeNodes: { price: number; volume: number }[];
  liquidityPools: LiquidityPool[];
  ema2004h: number;
  invalidation: { price: number; note: string } | null;
}): DailyPlan {
  const { currentPrice, e200Side, leg, keyLevels, volumeNodes, liquidityPools, ema2004h, invalidation } = a;
  const isLong = e200Side === 'above';

  // ---- 收集方向侧回调参考位（多头=下方支撑，空头=上方阻力；0.4%~8% 内有效） ----
  const cands: PullbackLevel[] = [];
  const inBand = (p: number) => {
    const d = Math.abs(currentPrice - p) / currentPrice;
    return d >= 0.004 && d <= 0.08;
  };
  const onSide = (p: number) => (isLong ? p < currentPrice : p > currentPrice);

  if (leg) {
    const fibMap: [number, PullbackLevel['source'], string][] = [
      [0.382, 'fib382', '回调38.2%'],
      [0.5, 'fib500', '回调50%'],
      [0.618, 'fib618', '回调61.8%'],
      [0.786, 'fib786', '回调78.6%'],
    ];
    for (const [ratio, src, label] of fibMap) {
      const f = leg.fibRetracements.find((x) => x.ratio === ratio);
      if (f && onSide(f.price) && inBand(f.price)) cands.push({ price: f.price, label, source: src });
    }
  }
  for (const k of keyLevels) {
    if (onSide(k.price) && inBand(k.price)) cands.push({ price: k.price, label: k.label, source: 'key' });
  }
  for (const v of [...volumeNodes].sort((x, y) => y.volume - x.volume).slice(0, 2)) {
    if (onSide(v.price) && inBand(v.price)) cands.push({ price: v.price, label: '成交密集区', source: 'volume' });
  }
  if (onSide(ema2004h) && inBand(ema2004h)) cands.push({ price: ema2004h, label: '4h EMA200', source: 'ema200' });
  for (const p of liquidityPools.slice(0, 4)) {
    if (onSide(p.price) && inBand(p.price)) {
      cands.push({ price: p.price, label: `流动性池·${p.side === 'low' ? '等低' : '等高'}`, source: 'pool' });
    }
  }

  // 去重（同价位 0.3% 内只留一个，优先 fib > key > 其他）
  const priority: Record<PullbackLevel['source'], number> = { fib382: 0, fib500: 0, fib618: 0, fib786: 0, key: 1, volume: 2, ema200: 3, pool: 4 };
  cands.sort((x, y) => priority[x.source] - priority[y.source]);
  const dedup: PullbackLevel[] = [];
  for (const c of cands) {
    if (!dedup.some((d) => Math.abs(d.price - c.price) / c.price < 0.003)) dedup.push(c);
  }
  dedup.sort((x, y) => Math.abs(currentPrice - x.price) - Math.abs(currentPrice - y.price));
  const pullbackLevels = dedup.slice(0, 6);

  // ---- 最佳进场区：滑窗聚类（容差 0.8%），取成员最多且离现价最近的簇 ----
  let entryZone: DailyPlan['entryZone'] = null;
  const sorted = [...pullbackLevels].sort((x, y) => x.price - y.price);
  for (let i = 0; i < sorted.length; i++) {
    const grp = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if ((sorted[j].price - sorted[i].price) / sorted[i].price <= 0.008) grp.push(sorted[j]);
      else break;
    }
    if (grp.length >= 2) {
      const lo = Math.min(...grp.map((g) => g.price));
      const hi = Math.max(...grp.map((g) => g.price));
      if (
        !entryZone ||
        grp.length > entryZone.methods.length ||
        (grp.length === entryZone.methods.length && Math.abs(currentPrice - (lo + hi) / 2) < Math.abs(currentPrice - entryZone.mid))
      ) {
        entryZone = { low: lo, high: hi, mid: (lo + hi) / 2, methods: grp.map((g) => g.label) };
      }
    }
  }
  // 无重叠簇：回落到 fib 0.5–0.618 段（经典回调进场带）
  if (!entryZone && leg) {
    const f5 = leg.fibRetracements.find((x) => x.ratio === 0.5);
    const f618 = leg.fibRetracements.find((x) => x.ratio === 0.618);
    if (f5 && f618 && onSide(f5.price) && onSide(f618.price)) {
      const lo = Math.min(f5.price, f618.price);
      const hi = Math.max(f5.price, f618.price);
      entryZone = { low: lo, high: hi, mid: (lo + hi) / 2, methods: ['回调50–61.8%带'] };
    }
  }

  const stopHint = entryZone
    ? isLong
      ? roundPrice(entryZone.low * 0.994)
      : roundPrice(entryZone.high * 1.006)
    : null;

  return {
    bias: isLong ? 'long' : 'short',
    biasText: isLong
      ? '多头方向：等回调至进场区分批低吸，跌破保护位观望'
      : '空头方向：等反抽至进场区分批高空，升破保护位观望',
    pullbackLevels,
    entryZone,
    stopHint,
    invalidationPrice: invalidation ? invalidation.price : null,
  };
}

// ==================== 预案生成 ====================

export interface TradePlan {
  id: 'D' | 'E';
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
  /** 触发概率主观标记：high=回调类（结构内），medium=突破类（需动能确认） */
  confidence: 'high' | 'medium';
}

function roundPrice(p: number): number {
  if (p >= 1000) return Math.round(p * 10) / 10;
  if (p >= 1) return Math.round(p * 100) / 100;
  return Math.round(p * 100000) / 100000;
}

function buildPlan(
  id: 'D' | 'E',
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
  /** D/E 双预案（leg 为 null 时可能为空） */
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
  /** 方向信号（实证校准：EMA200趋势中的MR极端回调，替代原bias作为方向依据） */
  directionSignal: DirectionSignal;
  /** 今日作战计划（任何时候都有方向/回调位/进场区答案） */
  dailyPlan: DailyPlan;
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

    // 方案 A/B（回调/突破）已按需求下线，仅保留结构失效位供 AI 解读引用
    if (isUp) {
      const swingLow = lows.length > 0 ? lows[lows.length - 1].price : fib(0.786);
      const stopA = Math.min(fib(0.786), swingLow) * 0.996;
      invalidation = { price: roundPrice(stopA), note: `4h 收盘跌破 ${roundPrice(stopA)} 则该推动腿结构失效` };
    } else {
      const swingHigh = highs.length > 0 ? highs[highs.length - 1].price : fib(0.786);
      const stopA = Math.max(fib(0.786), swingHigh) * 1.004;
      invalidation = { price: roundPrice(stopA), note: `4h 收盘升破 ${roundPrice(stopA)} 则该推动腿结构失效` };
    }
  }

  // 方案 C（超短线回踩）已按需求下线——系统仅保留信号触发的 D/E 点数档

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

  // ---------- 方向信号（实证校准，替代 bias 作为方向依据） ----------
  const directionSignal = calcDirectionSignal(k4h, currentPrice);

  // 信号触发 → 生成点数档预案（D 短线 / E 波段）
  // 结构来源：6 年 1h 分辨率竞速回测（2020-10~2026-08，128 个信号，前/后半 + 7 个年度全部验证）
  //   短线档 SL=0.12%(≈3点) TP=0.40%(≈10点)：胜率 42% 期望 +0.24R（7/7 年正，2021~2026 每年 +0.15~+0.54R）
  //   波段档 SL=0.24%(≈6点) TP=0.60%(≈15点)：胜率 44% 期望 +0.15R（7/7 年正）
  //   点数按现价 2490 定标；价格漂移时按百分比执行（10点=0.40%），显示时换算回点数
  if (directionSignal.active) {
    const s: 1 | -1 = directionSignal.dir === 'long' ? 1 : -1;
    const entry = roundPrice(currentPrice);
    const pts = (pct: number) => Math.round(currentPrice * pct * 10) / 10; // 当前价下的点数
    const dPlan = buildPlan(
      'D', '信号预案·短线（点数档）',
      directionSignal.dir === 'long' ? 'long' : 'short',
      `${directionSignal.stateText}（MR=${directionSignal.score}）· 方向确认后直接进场，目标 +${pts(0.004)}点，止损 ${pts(0.0012)}点，超时 3 天离场`,
      entry,
      roundPrice(currentPrice - s * currentPrice * 0.0012),
      roundPrice(currentPrice + s * currentPrice * 0.004),
      roundPrice(currentPrice + s * currentPrice * 0.008),
      'medium',
      {
        tp2Source: `+${pts(0.008)}点（延伸档，TP20/SL3 回测 +0.24R 同样稳定）`,
        tp1ProbabilityPct: 42,
        tp2ProbabilityPct: 42,
      },
    );
    (dPlan as any).evidence = `6年竞速回测（1h分辨率，128个信号）：TP10/SL3 期望+0.24R 胜率42%，7个年度全部为正；点数按现价定标，10点=0.40%`;
    plans.unshift(dPlan);

    const ePlan = buildPlan(
      'E', '信号预案·波段（点数档）',
      directionSignal.dir === 'long' ? 'long' : 'short',
      `${directionSignal.stateText}（MR=${directionSignal.score}）· 同方向波段档，目标 +${pts(0.006)}点，止损 ${pts(0.0024)}点，超时 5 天离场`,
      entry,
      roundPrice(currentPrice - s * currentPrice * 0.0024),
      roundPrice(currentPrice + s * currentPrice * 0.006),
      roundPrice(currentPrice + s * currentPrice * 0.008),
      'medium',
      {
        tp2Source: `+${pts(0.008)}点（TP20/SL6 回测 +0.12R）`,
        tp1ProbabilityPct: 44,
        tp2ProbabilityPct: 32,
      },
    );
    (ePlan as any).evidence = `6年竞速回测：TP15/SL6 期望+0.15R 胜率44%，7个年度全部为正；15点=0.60%`;
    plans.splice(1, 0, ePlan); // 紧随 D
  }

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
    directionSignal,
    dailyPlan: calcDailyPlan({
      currentPrice,
      e200Side: directionSignal.e200Side,
      leg,
      keyLevels,
      volumeNodes: vNodes,
      liquidityPools,
      // 4h EMA200（数据不足 200 根时退化为 EMA60，仅作参考位）
      ema2004h: k4h.length >= 200 ? emaSeries(k4h.map((k) => k.close), 200).slice(-1)[0] : t4h.ema60,
      invalidation,
    }),
  };
}
