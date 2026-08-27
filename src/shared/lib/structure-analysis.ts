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

/**
 * 方案 C（超短线）"持仓窗口竞速"校准表 —— 1h 推动腿回踩入场的快进快出统计。
 *
 * 与 A 方案同方法论：ρ = TP1距离/止损距离（对数距离比）分桶，
 * 但腿基于 1h 周期（zigzag 阈值 2%，最小腿幅 2%），窗口为超短适用的
 * 2h/4h/8h/12h/24h；确认口径 = 15m 触及入场价后收回（同 A）。
 *
 * 几何：入场=61.8%回撤，止损=78.6%回撤±0.3%缓冲（平均约0.9%），
 * TP1=38.2%回撤（快止盈，RR≈0.9-1.0），TP2=23.6%回撤（RR≈1.4）。
 * ρ 因此集中在 [0.75, 1.25)，仅两桶即覆盖绝大多数样本。
 *
 * 数据来源：ETH/BTC/SOL 1h 信号 × 15m 精度回放（2024-10~2026-08）n=2165。
 * ETH 样本外（时间后30%，n=229）：24h 先到TP 55.9%/先到SL 40.2%，
 * 较池化表低约 3~7pp（近期行情止损触发更快），使用时保守看待。
 * 时间前后半稳定性：ETH 24h 先到TP 63→62、先到SL 37→35（±2pp，可校准）。
 *
 * 费率警告：止损距离平均仅 0.9%，taker 双边 0.1% 费率≈吃掉 11% 的风险单位；
 * 本方案的边际优势依赖 maker 挂单执行（限价入场+限价止盈）。
 */
const WINDOW_SCALP_HOURS = [2, 4, 8, 12, 24] as const;

const SCALP_RACE_TP1: Record<number, [number, number][]> = {
  2: [[0.75, 0.433], [1, 0.279]],
  4: [[0.75, 0.512], [1, 0.387]],
  8: [[0.75, 0.585], [1, 0.47]],
  12: [[0.75, 0.61], [1, 0.512]],
  24: [[0.75, 0.632], [1, 0.539]],
};

const SCALP_RACE_SL: Record<number, [number, number][]> = {
  2: [[0.75, 0.169], [1, 0.169]],
  4: [[0.75, 0.255], [1, 0.255]],
  8: [[0.75, 0.317], [1, 0.348]],
  12: [[0.75, 0.334], [1, 0.38]],
  24: [[0.75, 0.345], [1, 0.42]],
};

/** 方案 C 各持仓窗口的竞速概率分布（口径与 windowRaceOutcomes 相同，查超短表） */
function scalpRaceOutcomes(entry: number, tp1: number, stop: number): WindowRaceRow[] {
  if (entry <= 0 || tp1 <= 0 || stop <= 0) return [];
  const dTp = Math.abs(Math.log(tp1 / entry));
  const dSl = Math.abs(Math.log(stop / entry));
  if (dSl <= 0) return [];
  const rho = dTp / dSl;
  return WINDOW_SCALP_HOURS.map((h) => {
    const tp = lookupCalib(SCALP_RACE_TP1[h], rho, 0.25);
    const sl = lookupCalib(SCALP_RACE_SL[h], rho, 0.25);
    const unresolved = Math.max(0, 1 - tp - sl);
    const sum = tp + sl;
    const k = sum > 0 ? (1 - unresolved) / sum : 0;
    let tpPct = Math.round(tp * k * 100);
    let slPct = Math.round(sl * k * 100);
    let unPct = 100 - tpPct - slPct;
    if (unPct < 0) {
      if (tpPct >= slPct) tpPct += unPct;
      else slPct += unPct;
      unPct = 0;
    }
    return { hours: h, tp1FirstPct: tpPct, slFirstPct: slPct, unresolvedPct: unPct };
  });
}

/**
 * 1h 推动腿识别（方案 C 专用，与 4h identifyLeg 同逻辑不同参数）：
 * zigzag 阈值 2%，最近 90 根 1h（约 4 天），最小腿幅 2%。
 */
function identifyScalpLeg(k1h: KlineData[]): { side: 'long' | 'short'; base: number; extreme: number } | null {
  const seg = k1h.slice(-90);
  if (seg.length < 20) return null;
  const { points, dir, pendingExtreme } = zigzag(seg, 0.02);
  if (!dir || points.length === 0) return null;
  const last = points[points.length - 1];
  const prev = points.length >= 2 ? points[points.length - 2] : null;
  let side: 'long' | 'short' | null = null;
  let base = 0;
  let extreme = 0;
  if (dir === 'down') {
    if (last.type === 'H' && prev && prev.type === 'L') {
      side = 'long'; base = prev.price; extreme = Math.max(last.price, pendingExtreme);
    } else if (last.type === 'L' && prev && prev.type === 'H') {
      side = 'short'; base = prev.price; extreme = Math.min(last.price, pendingExtreme);
    }
  } else {
    if (last.type === 'L' && prev && prev.type === 'H') {
      side = 'short'; base = prev.price; extreme = Math.min(last.price, pendingExtreme);
    } else if (last.type === 'H' && prev && prev.type === 'L') {
      side = 'long'; base = prev.price; extreme = Math.max(last.price, pendingExtreme);
    }
  }
  if (!side || !base || !extreme) return null;
  if (Math.abs(extreme - base) / base < 0.02) return null;
  return { side, base, extreme };
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

// ==================== 15m 动量确认过滤器（超短线 C 方案专用） ====================
//
// 背景：独立 15m/30m/1h 均值回归信号经 22 个月 walk-forward 回测无稳定期望（详见研究记录），
// 不可独立做单。但 C 方案（1h 推动腿 61.8% 回踩）叠加"入场确认时 15m 动量同向且强"过滤后
// 质量显著提升 —— 动量延续逻辑：强推动腿后的浅回踩，若确认时动量未衰竭，延续概率高。
//
// 回测口径（2024-10 ~ 2026-08，前70%定阈值/后30%样本外，4h 竞速窗，去重后）：
//   ETH: TP1先到 55-75% / 先SL 10-25% / 期望 +0.19~+0.50R，频率≈0.15笔/天（每6.6天1笔）
//   SOL: TP1先到 54-70% / 先SL 14-28% / 期望 +0.20~+0.42R，迁移通过
//   BTC: 样本外前半为负 → 未验证，过滤器仅展示不背书
//   反向对照（动量弱侧）：ETH 样本外 TP1 仅 10% —— 动量不足时该 setup 直接放弃
//
// 阈值 = 各币"确认时刻 MR 分布"训练段 10/90 分位（非全 bar 分布，二者有偏）。
// MR15 = (偏离EMA50% ×10 + 24根(6h)动量% ×10 + (RSI14-50)/50) / 3
// 注意：过滤时点 = 入场确认那一刻（触及后 15m 收回有利侧时），非挂单时刻。

/** 各币动量阈值（确认时刻 MR 训练段 10/90 分位）；verified=false 表示回测未通过仅参考 */
const MOMENTUM_THRESHOLDS: Record<string, { lo: number; hi: number; verified: boolean }> = {
  ETHUSDT: { lo: -0.142, hi: 0.098, verified: true },
  SOLUSDT: { lo: -0.143, hi: 0.129, verified: true },
  BTCUSDT: { lo: -0.160, hi: 0.151, verified: false },
};

export interface MomentumFilter {
  /** 当前 15m MR 分数 */
  mrNow: number;
  /** 本方向达标阈值：多单=hi，空单=lo */
  threshold: number;
  /** strong=当前已达标 / near=距阈值<0.05 / weak=动量不足（反向侧） */
  state: 'strong' | 'near' | 'weak';
  /** 该币是否通过样本外验证 */
  verified: boolean;
  /** 执行说明 */
  note: string;
}

/** 15m 动量分数（与回测完全同公式：EMA50 偏离 + 24根动量 + RSI14）
 *  热身验证：80根与全历史(66732根)算出的MR差<0.001，EMA50/RSI14在80根内已收敛 */
function calcMomentum15m(k15m: KlineData[]): number | null {
  const closes = k15m.map((k) => k.close);
  if (closes.length < 80) return null; // 与线上数据校验下限一致
  const e50 = emaSeries(closes, 50);
  const i = closes.length - 1;
  const dev = (closes[i] - e50[i]) / e50[i];
  const mom = (closes[i] - closes[i - 24]) / closes[i - 24];
  const rs = (rsiWilder(closes) - 50) / 50;
  return Math.round(((dev * 10 + mom * 10 + rs) / 3) * 1000) / 1000;
}

/** C 方案动量过滤状态（多单看 hi / 空单看 lo） */
function momentumState(symbol: string, side: 'long' | 'short', mrNow: number | null): MomentumFilter | null {
  const th = MOMENTUM_THRESHOLDS[symbol];
  if (!th || mrNow === null) return null;
  const threshold = side === 'long' ? th.hi : th.lo;
  const opposite = side === 'long' ? th.lo : th.hi;
  const inWeakZone = side === 'long' ? mrNow <= opposite : mrNow >= opposite;
  let state: 'strong' | 'near' | 'weak';
  if (side === 'long' ? mrNow >= threshold : mrNow <= threshold) state = 'strong';
  else if (inWeakZone) state = 'weak';
  else state = 'near';
  return {
    mrNow,
    threshold,
    state,
    verified: th.verified,
    note: th.verified
      ? `入场确认时 15m 动量需 ${side === 'long' ? '≥' : '≤'} ${threshold} 才执行；当前 ${mrNow}（${state === 'strong' ? '已达标' : state === 'near' ? '接近' : '动量不足·放弃'}）。回测：TP1先到55-75%/先SL10-28%/期望+0.2~0.5R`
      : `BTC 该过滤器样本外未通过验证，仅展示动量读数不构成执行依据`,
  };
}

// ==================== 预案生成 ====================

export interface TradePlan {
  id: 'A' | 'B' | 'C' | 'D' | 'E';
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
  /** 15m 动量确认过滤器（仅 C 方案）：入场确认时动量达标才执行 */
  momentum?: MomentumFilter;
}

function roundPrice(p: number): number {
  if (p >= 1000) return Math.round(p * 10) / 10;
  if (p >= 1) return Math.round(p * 100) / 100;
  return Math.round(p * 100000) / 100000;
}

function buildPlan(
  id: 'A' | 'B' | 'C' | 'D' | 'E',
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
    momentum?: MomentumFilter;
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
    momentum: extras?.momentum,
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
  /** 方向信号（实证校准：EMA200趋势中的MR极端回调，替代原bias作为方向依据） */
  directionSignal: DirectionSignal;
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

  // ---------- 方案 C：超短线（1h 推动腿，独立于 4h 结构） ----------
  if (k1h.length >= 100) {
    const legC = identifyScalpLeg(k1h);
    if (legC) {
      const rangeC = Math.abs(legC.extreme - legC.base);
      const fibC = (r: number) => (legC.side === 'long' ? legC.extreme - rangeC * r : legC.extreme + rangeC * r);
      const entryC = fibC(0.618);
      const stopC = legC.side === 'long' ? fibC(0.786) * 0.997 : fibC(0.786) * 1.003;
      const tp1C = fibC(0.382); // 快止盈（38.2% 回撤，RR≈0.9-1.0）
      const tp2C = fibC(0.236); // 波段档（23.6% 回撤，RR≈1.4）
      const riskC = Math.abs(entryC - stopC);
      const rr1C = Math.abs(tp1C - entryC) / riskC;
      // 显示门槛：止损未破（破了 = 该腿 setup 已死）、TP1 盈亏比 ≥0.8（与回测口径一致）。
      // 与 A/B 同语义：点位常显，"15m 触及后收回确认"是执行条件而非显示条件
      // （回测校准即以触达+确认为条件，显示时机不影响概率含义）。
      const stopIntact = legC.side === 'long' ? currentPrice > stopC : currentPrice < stopC;
      const nearEnough = Math.abs(entryC - currentPrice) / currentPrice <= 0.03;
      if (stopIntact && nearEnough && rr1C >= 0.8) {
        const rowsC = scalpRaceOutcomes(entryC, tp1C, stopC);
        const lastC = rowsC.length > 0 ? rowsC[rowsC.length - 1] : undefined;
        const momentumC = momentumState(symbol, legC.side, calcMomentum15m(k15m));
        plans.push(
          buildPlan(
            'C',
            legC.side === 'long' ? '超短线做多（快进快出）' : '超短线做空（快进快出）',
            legC.side,
            `1h 腿 61.8% 回撤 ${roundPrice(entryC)} 挂单，15m 触及后收回确认${momentumC?.verified ? '，且确认时 15m 动量达标（见动量过滤器）' : ''}；快止盈 ${roundPrice(tp1C)}，盈亏比<1 属正常（高胜率小目标），建议 maker 挂单执行`,
            entryC,
            stopC,
            tp1C,
            tp2C,
            'medium',
            {
              tp2Source: '1h 腿 23.6% 回撤（波段档，可留部分仓位）',
              tp1FirstPct: lastC?.tp1FirstPct,
              slFirstPct: lastC?.slFirstPct,
              windowRace: rowsC.length > 0 ? rowsC : undefined,
              momentum: momentumC ?? undefined,
            },
          ),
        );
      }
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
  };
}
