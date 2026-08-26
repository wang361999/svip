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

  // ---------- 预案 ----------
  const plans: TradePlan[] = [];
  let invalidation: { price: number; note: string } | null = null;

  if (leg) {
    const fib = (r: number) => leg.fibRetracements.find((f) => f.ratio === r)!.price;
    const ext = (r: number) => leg.fibExtensions.find((f) => f.ratio === r)!.price;
    const { highs, lows } = findSwings(k4h.slice(-60));

    if (leg.direction === 'up') {
      // ---- 上涨腿：回调做多 + 突破做多 ----
      const entryA = fib(0.618);
      const swingLow = lows.length > 0 ? lows[lows.length - 1].price : fib(0.786);
      const stopA = Math.min(fib(0.786), swingLow) * 0.996; // 结构位下方留 0.4% 缓冲
      // TP1 = 23.6% 回撤位（entry 上方第一阻力）；若离 entry 太近（盈亏比<1）取 entry~端点中间
      let tp1A = fib(0.236);
      if ((tp1A - entryA) / (entryA - stopA) < 1) tp1A = entryA + (leg.endPrice - entryA) / 2;
      plans.push(
        buildPlan('A', '回调做多（首选）', 'long', `回踩 ${roundPrice(entryA)} 需求区（本腿 61.8% 回撤），15m 出现止跌结构后入场`, entryA, stopA, tp1A, leg.endPrice, 'high'),
      );
      const entryB = leg.endPrice * 1.005; // 突破前高后回踩
      const stopB = leg.endPrice * 0.988; // 突破点下方 1.2% 缓冲
      plans.push(
        buildPlan('B', '突破追多（备选）', 'long', `1h 放量突破 ${roundPrice(leg.endPrice)} 后回踩不破`, entryB, stopB, entryB + leg.range * 0.1, ext(1.618), 'medium'),
      );
      invalidation = { price: roundPrice(stopA), note: `4h 收盘跌破 ${roundPrice(stopA)} 则本腿结构失效，做多预案作废` };
    } else {
      // ---- 下跌腿：反弹做空 + 跌破追空 ----
      const entryA = fib(0.618);
      const swingHigh = highs.length > 0 ? highs[highs.length - 1].price : fib(0.786);
      const stopA = Math.max(fib(0.786), swingHigh) * 1.004;
      let tp1A = fib(0.236);
      if ((entryA - tp1A) / (stopA - entryA) < 1) tp1A = entryA - (entryA - leg.endPrice) / 2;
      plans.push(
        buildPlan('A', '反弹做空（首选）', 'short', `反弹至 ${roundPrice(entryA)} 供给区（本腿 61.8% 回撤），15m 出现滞涨结构后入场`, entryA, stopA, tp1A, leg.endPrice, 'high'),
      );
      const entryB = leg.endPrice * 0.995;
      const stopB = leg.endPrice * 1.012;
      plans.push(
        buildPlan('B', '跌破追空（备选）', 'short', `1h 放量跌破 ${roundPrice(leg.endPrice)} 后反抽不破`, entryB, stopB, entryB - leg.range * 0.1, ext(1.618), 'medium'),
      );
      invalidation = { price: roundPrice(stopA), note: `4h 收盘升破 ${roundPrice(stopA)} 则本腿结构失效，做空预案作废` };
    }
  }

  // ---------- 关键位 ----------
  const rawLevels: { price: number; label: string }[] = [];
  if (leg) {
    rawLevels.push({ price: leg.endPrice, label: '本腿端点' });
    rawLevels.push({ price: leg.startPrice, label: '本腿起点' });
    for (const f of leg.fibRetracements) {
      rawLevels.push({ price: f.price, label: `本腿${Math.round(f.ratio * 100)}%回撤` });
    }
    for (const e of leg.fibExtensions) {
      rawLevels.push({ price: e.price, label: `本腿${e.ratio}扩展` });
    }
  }
  for (const g of gannEighths(k4h, currentPrice)) {
    rawLevels.push({ price: g.price, label: g.label });
  }
  // EMA 参考位
  rawLevels.push({ price: t4h.ema20, label: '4h EMA20' });
  rawLevels.push({ price: t4h.ema60, label: '4h EMA60' });
  // 成交密集区
  const vNodes = volumeNodes(k4h);
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
    bias,
    biasText,
  };
}
