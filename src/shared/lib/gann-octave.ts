/**
 * 江恩八分法动态支撑阻力策略（ETH 4h）— 完整策略引擎
 *
 * 策略规格（严格执行）：
 * ① 波段识别：枢轴点算法，左右各5根K线确认局部极值；取最后确认的波段低点L与高点H
 * ② 八分位：基于(L,H)生成9档价位 0%/12.5%/25%/37.5%/50%/62.5%/75%/87.5%/100%
 *    重点监控 50%（最强）、25%/75%（次强）、37.5%/62.5%（辅助）
 * ③ AI信号过滤：随机森林（离线训练权重内嵌），输出 买入/卖出/观望 + 置信度(0~1)
 * ④ 交易规则：
 *    做多（全部满足）：价触及50%或62.5%分位(偏差<0.5%) + 看涨K线形态 + AI买入置信≥0.65
 *                     + RSI(14)>30 + 日线趋势上升(价>日线MA30)
 *    做空（全部满足）：价触及50%或37.5%分位 + 看跌形态 + AI卖出置信≥0.65 + RSI(14)<70 + 日线下降
 *    突破追单：强势突破87.5%分位且AI确认 → 开多目标100%；跌破12.5%且AI确认 → 开空目标0%
 * ④b 15分钟入场确认（降周期触发）：
 *    4h五条件共振出信号后不立即进场；在信号bar收盘后的16根15m窗口内等同向确认
 *    （做多：15m收盘>EMA20且阳线；做空：收盘<EMA20且阴线）；
 *    确认根15m收盘价为生效进场价；确认前触及止损→信号作废；窗口结束未确认→过期；
 *    15m数据不足（<30根或起点晚于信号bar）→ 降级按4h信号价直接进场（不阻塞）
 * ⑤ 风险仓位：止损=入场分位的上一/下一档八分位（距离不小于1.5×ATR）；
 *    分批止盈 TP1=最近一档、TP2=再下一档；单笔最大风险=权益2%；
 *    波动率过滤：ATR(14)超过30天ATR均值2倍 → 暂停开仓
 * ⑥ 动态更新：波段新高/新低自动重算八分位；每日收盘重评日线趋势
 *
 * 无回测逻辑 — 纯实盘信号引擎。所有判定只用已收盘K线。
 */
import type { KlineData } from './market-data';

export const STRATEGY_ID = 'gann-octave-4h-v1';

const FOUR_H_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIFTEEN_MS = 15 * 60 * 1000;
/** 价格格式化（整数位≥100留2位小数，否则4位） */
const fp0 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 });

// ==================== 参数 ====================

export interface GannOctaveParams {
  /** 枢轴确认强度：左右各N根 */
  pivotStrength: number;
  /** 触及分位判定偏差（0.5%） */
  deviationPct: number;
  rsiPeriod: number;
  rsiLongMin: number;
  rsiShortMax: number;
  /** AI 置信度门槛 */
  aiConfThreshold: number;
  /** 日线趋势 MA 周期 */
  dailyMaPeriod: number;
  atrPeriod: number;
  /** 止损距离下限（ATR 倍数） */
  atrStopFloorMult: number;
  /** 极端行情过滤：当前ATR > N×30天ATR均值 → 暂停 */
  atrVolFilterMult: number;
  /** 30天 ≈ 180根4h */
  atrVolWindowBars: number;
  /** 最小波段区间宽度（占价%，窄区间八分位无意义） */
  minRangePct: number;
  /** 信号回看窗口（根）：生命周期扫描范围 */
  signalLookbackBars: number;
}

export const DEFAULT_GO_PARAMS: GannOctaveParams = {
  pivotStrength: 5,
  deviationPct: 0.005,
  rsiPeriod: 14,
  rsiLongMin: 30,
  rsiShortMax: 70,
  aiConfThreshold: 0.65,
  dailyMaPeriod: 30,
  atrPeriod: 14,
  atrStopFloorMult: 1.5,
  atrVolFilterMult: 2,
  atrVolWindowBars: 180,
  minRangePct: 1.5,
  signalLookbackBars: 42,
};

// ==================== 状态类型 ====================

export interface OctaveLevel {
  /** 档位序号 0~8（0%=波段低点，8%=波段高点） */
  index: number;
  /** 百分比标注 */
  label: string;
  price: number;
}

export interface GannOctaveOrder {
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  /** 止损占入场价比（小数） */
  riskPct: number;
  /** 止损来源：octave=分位档 / atr=1.5ATR下限垫高 */
  stopSource: 'octave' | 'atr';
  /** 触发分位（4=50%、5=62.5%…） */
  levelIdx: number;
}

export interface GannOctaveState {
  /** waiting观望 / pending信号触发(待15m确认) / confirmed15m已确认待进场 / filled持仓中 / closed已了结 */
  status: 'waiting' | 'pending' | 'confirmed' | 'filled' | 'closed';
  direction: 'long' | 'short';
  signalType: 'pullback' | 'breakout' | null;
  /** 八分位阶梯（0~8档） */
  octaves: OctaveLevel[];
  swingHigh: number | null;
  swingLow: number | null;
  swingHighTime: number | null;
  swingLowTime: number | null;
  /** 现价在波段区间内位置（0~100） */
  positionPct: number | null;
  /** 日线趋势：up=价>MA30 / down=价<MA30 */
  dailyTrend: 'up' | 'down' | 'unknown';
  dailyMa30: number | null;
  rsi: number | null;
  atr: number | null;
  /** 当前ATR / 30天ATR均值 */
  atrRatio: number | null;
  /** 极端波动暂停开仓 */
  volatilityPaused: boolean;
  /** AI 模型输出（已温度校准） */
  ai: { hold: number; buy: number; sell: number; action: 'buy' | 'sell' | 'hold'; confidence: number } | null;
  /** 最新K线形态名（null=无已识别形态） */
  pattern: string | null;
  /** 最新K线进场五条件（UI清单；触发分位索引 levelIdx=-1 未触及） */
  checks: {
    levelTouched: boolean;
    levelIdx: number;
    patternOk: boolean;
    aiOk: 'buy' | 'sell' | 'none';
    rsiOk: boolean;
    dailyOk: boolean;
  };
  order: GannOctaveOrder | null;
  outcome: 'tp' | 'sl' | null;
  /** 15分钟入场确认层（4h信号 → 15m同向确认才进场；数据不足降级直接进场） */
  m15: {
    /** 15m 数据可用性（<30根或时间不覆盖 → bypass 降级） */
    available: boolean;
    /** waiting等确认 / confirmed已确认 / expired窗口过期末确认 / invalidated确认前触及止损 / bypass数据不足降级直进 */
    status: 'waiting' | 'confirmed' | 'expired' | 'invalidated' | 'bypass';
    /** 确认15m收盘时刻 */
    confirmTime: number | null;
    /** 15m确认进场价（覆盖order.entry） */
    entry: number | null;
    /** 窗口内已扫描/待扫描说明 */
    reason: string;
  };
  waitingReason: string;
  /** 推理链（面板展示） */
  chain: string[];
  insufficientData: boolean;
}

// ==================== 指标（与训练口径完全一致） ====================

function emaSeries(v: number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  const out: (number | null)[] = new Array(v.length).fill(null);
  let e: number | null = null;
  for (let i = 0; i < v.length; i++) {
    e = e == null ? v[i] : v[i] * k + e * (1 - k);
    out[i] = i >= n - 1 ? e : null;
  }
  return out;
}

function rsiSeries(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) {
      g += up / n; l += dn / n;
      if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

function macdHistSeries(closes: number[]): (number | null)[] {
  const f = emaSeries(closes, 12);
  const s = emaSeries(closes, 26);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  const k = 2 / 10; // EMA9（信号线）
  let e: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    if (f[i] == null || s[i] == null) continue;
    const d = (f[i] as number) - (s[i] as number);
    e = e == null ? d : d * k + e * (1 - k);
    if (i >= 33) out[i] = d - (e as number);
  }
  return out;
}

function atrSeries(bars: KlineData[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let a: number | null = null;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    a = a == null ? tr : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

// ==================== K线形态（看涨/看跌） ====================

interface BarShape { open: number; high: number; low: number; close: number; body: number; upper: number; lower: number }

function shape(k: KlineData): BarShape {
  const body = Math.abs(k.close - k.open);
  return {
    open: k.open, high: k.high, low: k.low, close: k.close, body,
    upper: k.high - Math.max(k.open, k.close),
    lower: Math.min(k.open, k.close) - k.low,
  };
}

/** 看涨形态：锤子线 / 看涨吞没 / 早晨之星（任一命中返回名称） */
function bullishPattern(bars: KlineData[], i: number, atr: number): string | null {
  const c = shape(bars[i]);
  // 锤子线：下影 ≥ 2×实体，上影 ≤ 0.6×实体
  if (c.body > 0 && c.lower >= 2 * c.body && c.upper <= 0.6 * c.body) return '锤子线';
  if (i >= 1) {
    const p = shape(bars[i - 1]);
    // 看涨吞没：前阴后阳，实体包住
    if (
      p.close < p.open && c.close > c.open &&
      c.open <= p.close * 1.001 && c.close >= p.open * 0.999 &&
      c.body >= 0.3 * atr
    ) return '看涨吞没';
  }
  if (i >= 2) {
    const b1 = shape(bars[i - 2]);
    const b2 = shape(bars[i - 1]);
    // 早晨之星：大阴 + 小实体 + 阳线收复 b1 实体中点
    if (
      b1.close < b1.open && b1.body >= 0.5 * atr &&
      b2.body <= 0.5 * b1.body &&
      c.close > c.open && c.close > (b1.open + b1.close) / 2
    ) return '早晨之星';
  }
  return null;
}

/** 看跌形态：射击之星 / 看跌吞没 / 黄昏之星 */
function bearishPattern(bars: KlineData[], i: number, atr: number): string | null {
  const c = shape(bars[i]);
  // 射击之星：上影 ≥ 2×实体，下影 ≤ 0.6×实体
  if (c.body > 0 && c.upper >= 2 * c.body && c.lower <= 0.6 * c.body) return '射击之星';
  if (i >= 1) {
    const p = shape(bars[i - 1]);
    // 看跌吞没：前阳后阴
    if (
      p.close > p.open && c.close < c.open &&
      c.open >= p.close * 0.999 && c.close <= p.open * 1.001 &&
      c.body >= 0.3 * atr
    ) return '看跌吞没';
  }
  if (i >= 2) {
    const b1 = shape(bars[i - 2]);
    const b2 = shape(bars[i - 1]);
    // 黄昏之星
    if (
      b1.close > b1.open && b1.body >= 0.5 * atr &&
      b2.body <= 0.5 * b1.body &&
      c.close < c.open && c.close < (b1.open + b1.close) / 2
    ) return '黄昏之星';
  }
  return null;
}

// ==================== 特征（21维，与训练完全一致） ====================

const FEATURE_NAMES = [
  '偏离0%', '偏离12.5%', '偏离25%', '偏离37.5%', '偏离50%', '偏离62.5%', '偏离75%', '偏离87.5%', '偏离100%',
  'RSI14', 'MACD柱%', '布林%B', '量能变化', 'ATR%', '区间位置',
  '下影/ATR', '上影/ATR', '有向实体/ATR', '看涨形态', '看跌形态', '3根动量%',
];

function buildFeatureVector(
  bars: KlineData[],
  i: number,
  closes: number[],
  ocs: number[],
  rsi: number,
  hist: number,
  bbPctB: number,
  volRatio: number,
  atrVal: number,
  bullFlag: boolean,
  bearFlag: boolean,
): number[] {
  const c = closes[i];
  const s = shape(bars[i]);
  const f: number[] = [];
  for (let j = 0; j <= 8; j++) f.push(((c - ocs[j]) / c) * 100);
  f.push(rsi);
  f.push((hist / c) * 100);
  f.push(Math.max(-1, Math.min(2, bbPctB)));
  f.push(volRatio);
  f.push((atrVal / c) * 100);
  const range = ocs[8] - ocs[0];
  f.push(Math.max(-0.5, Math.min(1.5, (c - ocs[0]) / range)));
  f.push(atrVal > 0 ? s.lower / atrVal : 0);
  f.push(atrVal > 0 ? s.upper / atrVal : 0);
  f.push(atrVal > 0 ? (bars[i].close >= bars[i].open ? 1 : -1) * s.body / atrVal : 0);
  f.push(bullFlag ? 1 : 0);
  f.push(bearFlag ? 1 : 0);
  f.push(i >= 3 ? ((c / closes[i - 3]) - 1) * 100 : 0);
  return f;
}

// ==================== 主分析 ====================

export function analyzeGannOctave(
  k4hRaw: KlineData[],
  k1dRaw: KlineData[],
  currentPrice: number,
  k15mRaw: KlineData[] = [],
): GannOctaveState {
  const p = DEFAULT_GO_PARAMS;
  const chain: string[] = [];

  const empty = (reason: string, insufficient = false): GannOctaveState => ({
    status: 'waiting', direction: 'long', signalType: null,
    octaves: [], swingHigh: null, swingLow: null, swingHighTime: null, swingLowTime: null,
    positionPct: null, dailyTrend: 'unknown', dailyMa30: null, rsi: null, atr: null, atrRatio: null,
    volatilityPaused: false, ai: null, pattern: null,
    checks: { levelTouched: false, levelIdx: -1, patternOk: false, aiOk: 'none', rsiOk: false, dailyOk: false },
    order: null, outcome: null,
    m15: { available: false, status: 'bypass', confirmTime: null, entry: null, reason: '无信号无需确认' },
    waitingReason: reason, chain, insufficientData: insufficient,
  });

  // 0. 剔除未收盘K线（4h 与 1d）
  const now = Date.now();
  const bars = k4hRaw.filter((k) => k.time + FOUR_H_MS <= now);
  const dBars = k1dRaw.filter((k) => k.time + DAY_MS <= now);
  const n = bars.length;

  if (n < 60 || dBars.length < p.dailyMaPeriod + 1) {
    return empty(`数据不足：4h需≥60根(实际${n})，日线需≥${p.dailyMaPeriod + 1}根(实际${dBars.length})`, true);
  }

  // 1. 指标序列（全量一次，逐bar按索引取 — 与训练口径一致）
  const closes = bars.map((k) => k.close);
  const vols = bars.map((k) => k.volume);
  const rsi = rsiSeries(closes, p.rsiPeriod);
  const hist = macdHistSeries(closes);
  const atr = atrSeries(bars, p.atrPeriod);

  // 布林 %B 与量能比（逐bar数组）
  const bbB: (number | null)[] = new Array(n).fill(null);
  for (let i = 19; i < n; i++) {
    const w = closes.slice(i - 19, i + 1);
    const m = w.reduce((s, v) => s + v, 0) / 20;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / 20);
    bbB[i] = sd > 0 ? (closes[i] - (m - 2 * sd)) / (4 * sd) : 0.5;
  }
  const volR: (number | null)[] = new Array(n).fill(null);
  for (let i = 5; i < n; i++) {
    const v5 = vols.slice(i - 5, i).reduce((s, v) => s + v, 0) / 5;
    volR[i] = v5 > 0 ? vols[i] / v5 - 1 : 0;
  }

  // 2. 枢轴点（左右各5根确认）→ 每个bar视角下「最后确认」的波段高/低
  const K = p.pivotStrength;
  const pivHighs: { idx: number; price: number }[] = [];
  const pivLows: { idx: number; price: number }[] = [];
  for (let i = K; i <= n - 1 - K; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= K; j++) {
      if (bars[i].high <= bars[i - j].high || bars[i].high <= bars[i + j].high) isH = false;
      if (bars[i].low >= bars[i - j].low || bars[i].low >= bars[i + j].low) isL = false;
    }
    if (isH) pivHighs.push({ idx: i, price: bars[i].high });
    if (isL) pivLows.push({ idx: i, price: bars[i].low });
  }

  /** bar i 视角下的八分位（最后确认枢轴，确认=i-pivotIdx≥5 已由扫描范围保证） */
  const octavesAsOf = (i: number): number[] | null => {
    let H: { idx: number; price: number } | null = null;
    let L: { idx: number; price: number } | null = null;
    for (let k = pivHighs.length - 1; k >= 0; k--) if (pivHighs[k].idx <= i - K) { H = pivHighs[k]; break; }
    for (let k = pivLows.length - 1; k >= 0; k--) if (pivLows[k].idx <= i - K) { L = pivLows[k]; break; }
    if (!H || !L || H.price <= L.price) return null;
    const range = H.price - L.price;
    const ocs: number[] = [];
    for (let j = 0; j <= 8; j++) ocs.push(L.price + range * (j / 8));
    return ocs;
  };

  // 3. 日线趋势（MA30，bar i 收盘时刻取最后已收盘日线）
  const dCloses = dBars.map((k) => k.close);
  const dMa: number[] = []; // 逐日线bar的 MA30
  for (let j = 0; j < dBars.length; j++) {
    if (j < p.dailyMaPeriod - 1) { dMa.push(NaN); continue; }
    const w = dCloses.slice(j - p.dailyMaPeriod + 1, j + 1);
    dMa.push(w.reduce((s, v) => s + v, 0) / p.dailyMaPeriod);
  }
  const dailyAsOf = (closeTimeMs: number): { trend: 'up' | 'down' | 'unknown'; ma: number | null } => {
    let j = -1;
    for (let q = dBars.length - 1; q >= 0; q--) {
      if (dBars[q].time + DAY_MS <= closeTimeMs) { j = q; break; }
    }
    if (j < 0 || Number.isNaN(dMa[j])) return { trend: 'unknown', ma: null };
    return { trend: dCloses[j] > dMa[j] ? 'up' : 'down', ma: dMa[j] };
  };

  // 4. AI 预测（逐bar缓存）
  const aiCache = new Map<number, { hold: number; buy: number; sell: number }>();
  const aiAsOf = (i: number) => {
    if (aiCache.has(i)) return aiCache.get(i)!;
    const ocs = octavesAsOf(i);
    if (!ocs || rsi[i] == null || hist[i] == null || atr[i] == null || bbB[i] == null || volR[i] == null) return null;
    const a = atr[i] as number;
    const x = buildFeatureVector(
      bars, i, closes, ocs,
      rsi[i] as number, hist[i] as number,
      bbB[i] as number, volR[i] as number,
      a,
      !!bullishPattern(bars, i, a),
      !!bearishPattern(bars, i, a),
    );
    const r = predictGannAI(x);
    aiCache.set(i, r);
    return r;
  };

  // 5. 波动率过滤（ATR / 30天均值）
  const atrRatioAsOf = (i: number): number | null => {
    const a = atr[i];
    if (a == null) return null;
    const wStart = Math.max(p.atrPeriod, i - p.atrVolWindowBars);
    const win: number[] = [];
    for (let q = wStart; q < i; q++) if (atr[q] != null) win.push(atr[q] as number);
    if (win.length < 30) return null;
    const mean = win.reduce((s, v) => s + v, 0) / win.length;
    return mean > 0 ? a / mean : null;
  };

  /** bar i 触及的分位（返回档位索引；做多区 4=50%/5=62.5%，做空区 4=50%/3=37.5%） */
  const touchedLevel = (i: number, dir: 'long' | 'short', ocs: number[]): number => {
    const c = closes[i];
    const cands = dir === 'long' ? [4, 5] : [4, 3];
    let best = -1, bestDist = Infinity;
    for (const idx of cands) {
      const d = Math.abs(c - ocs[idx]) / c;
      if (d <= p.deviationPct && d < bestDist) { bestDist = d; best = idx; }
    }
    return best;
  };

  // ================= 信号扫描：窗口内找最近一根满足全部条件的K线 =================
  interface Signal {
    barIdx: number;
    direction: 'long' | 'short';
    signalType: 'pullback' | 'breakout';
    order: GannOctaveOrder;
    aiConf: number;
    pattern: string;
  }

  const signals: Signal[] = [];
  const wStart = Math.max(60, n - p.signalLookbackBars);

  for (let i = wStart; i < n; i++) {
    const ocs = octavesAsOf(i);
    if (!ocs || atr[i] == null || rsi[i] == null) continue;
    const a = atr[i] as number;
    const c = closes[i];

    // 极端波动暂停（该bar视角）
    const ratio = atrRatioAsOf(i);
    if (ratio != null && ratio > p.atrVolFilterMult) continue;

    const ai = aiAsOf(i);
    if (!ai) continue;
    const dTrend = dailyAsOf(bars[i].time + FOUR_H_MS);
    const patB = bullishPattern(bars, i, a);
    const patS = bearishPattern(bars, i, a);

    // --- 回调做多：50%/62.5% + 看涨形态 + AI≥0.65 + RSI>30 + 日线升 ---
    const longLv = touchedLevel(i, 'long', ocs);
    if (longLv >= 0 && patB && ai.buy >= p.aiConfThreshold && (rsi[i] as number) > p.rsiLongMin && dTrend.trend === 'up') {
      const stop0 = ocs[longLv - 1];
      const stop = c - stop0 >= p.atrStopFloorMult * a ? stop0 : c - p.atrStopFloorMult * a;
      signals.push({
        barIdx: i, direction: 'long', signalType: 'pullback',
        order: {
          entry: c, stop,
          tp1: ocs[longLv + 1], tp2: ocs[Math.min(8, longLv + 2)],
          riskPct: (c - stop) / c,
          stopSource: c - stop0 >= p.atrStopFloorMult * a ? 'octave' : 'atr',
          levelIdx: longLv,
        },
        aiConf: ai.buy, pattern: patB,
      });
    }

    // --- 反弹做空：50%/37.5% + 看跌形态 + AI≥0.65 + RSI<70 + 日线降 ---
    const shortLv = touchedLevel(i, 'short', ocs);
    if (shortLv >= 0 && patS && ai.sell >= p.aiConfThreshold && (rsi[i] as number) < p.rsiShortMax && dTrend.trend === 'down') {
      const stop0 = ocs[shortLv + 1];
      const stop = stop0 - c >= p.atrStopFloorMult * a ? stop0 : c + p.atrStopFloorMult * a;
      signals.push({
        barIdx: i, direction: 'short', signalType: 'pullback',
        order: {
          entry: c, stop,
          tp1: ocs[shortLv - 1], tp2: ocs[Math.max(0, shortLv - 2)],
          riskPct: (stop - c) / c,
          stopSource: stop0 - c >= p.atrStopFloorMult * a ? 'octave' : 'atr',
          levelIdx: shortLv,
        },
        aiConf: ai.sell, pattern: patS,
      });
    }

    // --- 突破追多：收盘强势上破87.5% + AI确认 → 目标100%（进场必须在87.5%~100%之间，越过100%目标失效） ---
    if (c > ocs[7] && c < ocs[8] && c > bars[i].open && ai.buy >= p.aiConfThreshold) {
      const stop0 = ocs[7];
      const stop = c - stop0 >= p.atrStopFloorMult * a ? stop0 : c - p.atrStopFloorMult * a;
      signals.push({
        barIdx: i, direction: 'long', signalType: 'breakout',
        order: {
          entry: c, stop, tp1: ocs[8], tp2: ocs[8],
          riskPct: (c - stop) / c,
          stopSource: c - stop0 >= p.atrStopFloorMult * a ? 'octave' : 'atr',
          levelIdx: 7,
        },
        aiConf: ai.buy, pattern: '突破87.5%',
      });
    }

    // --- 突破追空：收盘跌破12.5% + AI确认 → 目标0%（进场必须在0%~12.5%之间） ---
    if (c < ocs[1] && c > ocs[0] && c < bars[i].open && ai.sell >= p.aiConfThreshold) {
      const stop0 = ocs[1];
      const stop = stop0 - c >= p.atrStopFloorMult * a ? stop0 : c + p.atrStopFloorMult * a;
      signals.push({
        barIdx: i, direction: 'short', signalType: 'breakout',
        order: {
          entry: c, stop, tp1: ocs[0], tp2: ocs[0],
          riskPct: (stop - c) / c,
          stopSource: stop0 - c >= p.atrStopFloorMult * a ? 'octave' : 'atr',
          levelIdx: 1,
        },
        aiConf: ai.sell, pattern: '跌破12.5%',
      });
    }
  }

  // ================= 最新bar的展示态（八分位 / AI / 检查清单） =================
  const last = n - 1;
  const ocsNow = octavesAsOf(last);
  const price = currentPrice > 0 ? currentPrice : closes[last];
  const aiNow = aiAsOf(last);
  const atrNow = atr[last];
  const ratioNow = atrRatioAsOf(last);
  const dNow = dailyAsOf(bars[last].time + FOUR_H_MS);
  const patBNow = atrNow != null ? bullishPattern(bars, last, atrNow) : null;
  const patSNow = atrNow != null ? bearishPattern(bars, last, atrNow) : null;

  // 区间宽度门槛
  if (!ocsNow) return empty('近端无已确认的波段高/低枢轴（左右各5根确认），等待波段形成');
  const rangeNow = ocsNow[8] - ocsNow[0];
  if (rangeNow / price < p.minRangePct / 100) {
    return empty(`波段区间过窄（${((rangeNow / price) * 100).toFixed(2)}% < ${p.minRangePct}%），八分位间距无意义，等待区间扩张`);
  }

  const octaves: OctaveLevel[] = ocsNow.map((pr, idx) => ({
    index: idx,
    label: `${(idx / 8 * 100).toFixed(1)}%`.replace('.0%', '%'),
    price: pr,
  }));

  // 找到当前枢轴源
  let sh: { idx: number; price: number } | null = null;
  let sl: { idx: number; price: number } | null = null;
  for (let k = pivHighs.length - 1; k >= 0; k--) if (pivHighs[k].idx <= last - K) { sh = pivHighs[k]; break; }
  for (let k = pivLows.length - 1; k >= 0; k--) if (pivLows[k].idx <= last - K) { sl = pivLows[k]; break; }

  const positionPct = ((price - ocsNow[0]) / rangeNow) * 100;

  // 检查清单（最新bar，方向按日线趋势定）
  const wantDir: 'long' | 'short' = dNow.trend === 'down' ? 'short' : 'long';
  const lvNow = touchedLevel(last, wantDir, ocsNow);
  const aiActionNow: 'buy' | 'sell' | 'none' = aiNow
    ? (aiNow.buy >= p.aiConfThreshold ? 'buy' : aiNow.sell >= p.aiConfThreshold ? 'sell' : 'none')
    : 'none';

  const baseChecks = {
    levelTouched: lvNow >= 0,
    levelIdx: lvNow,
    patternOk: wantDir === 'long' ? !!patBNow : !!patSNow,
    aiOk: aiActionNow,
    rsiOk: rsi[last] != null && (wantDir === 'long' ? (rsi[last] as number) > p.rsiLongMin : (rsi[last] as number) < p.rsiShortMax),
    dailyOk: dNow.trend === (wantDir === 'long' ? 'up' : 'down'),
  };

  const state: GannOctaveState = {
    status: 'waiting', direction: 'long', signalType: null,
    octaves, swingHigh: sh?.price ?? null, swingLow: sl?.price ?? null,
    swingHighTime: sh ? bars[sh.idx].time : null, swingLowTime: sl ? bars[sl.idx].time : null,
    positionPct: Math.max(-20, Math.min(120, positionPct)),
    dailyTrend: dNow.trend, dailyMa30: dNow.ma,
    rsi: rsi[last], atr: atrNow, atrRatio: ratioNow,
    volatilityPaused: ratioNow != null && ratioNow > p.atrVolFilterMult,
    ai: aiNow
      ? {
          ...aiNow,
          action: aiNow.buy > aiNow.sell ? (aiNow.buy > aiNow.hold ? 'buy' : 'hold') : (aiNow.sell > aiNow.hold ? 'sell' : 'hold'),
          confidence: Math.round(Math.max(aiNow.buy, aiNow.sell, aiNow.hold) * 100),
        }
      : null,
    pattern: patBNow || patSNow,
    checks: baseChecks,
    order: null, outcome: null,
    m15: { available: k15mRaw.filter((k) => k.time + FIFTEEN_MS <= Date.now()).length >= 30, status: 'waiting', confirmTime: null, entry: null, reason: '暂无信号' },
    waitingReason: '', chain, insufficientData: false,
  };

  // ================= 生命周期：最近信号 → 后续bar推演成交/离场 =================
  if (signals.length > 0) {
    // 最新一根信号bar（同bar多信号：回调优先于突破，其次AI置信高者）
    const byBar = new Map<number, Signal[]>();
    signals.forEach((s) => { const g = byBar.get(s.barIdx) || []; g.push(s); byBar.set(s.barIdx, g); });
    const lastBar = Math.max(...Array.from(byBar.keys()));
    const sig = (byBar.get(lastBar) || []).sort((a, b) =>
      (a.signalType === 'pullback' ? -1 : 1) - (b.signalType === 'pullback' ? -1 : 1) || b.aiConf - a.aiConf,
    )[0];
    const o = sig.order;

    // ============ 15分钟入场确认层（4h信号 → 15m同向确认才进场） ============
    // 窗口：信号bar收盘后一个4h周期内的16根15m。确认=收盘过EMA20且同向K线；作废=确认前触及止损
    const tSigClose = bars[sig.barIdx].time + FOUR_H_MS;
    const winEnd = tSigClose + FOUR_H_MS;
    const m15Bars = k15mRaw.filter((k) => k.time + FIFTEEN_MS <= now);
    const m15Ready = m15Bars.length >= 30 && m15Bars[0].time <= tSigClose;
    let m15: GannOctaveState['m15'];
    let entryEff = o.entry; // 生效进场价（15m确认后覆盖）
    if (!m15Ready) {
      m15 = { available: false, status: 'bypass', confirmTime: null, entry: null, reason: `15m数据不足（${m15Bars.length}根${m15Bars.length > 0 ? '，起点晚于信号bar' : ''}），降级按4h信号价直接进场` };
    } else {
      // 15m EMA20（全量计算，窗口内取值）
      const m15Closes = m15Bars.map((k) => k.close);
      const m15Ema = emaSeries(m15Closes, 20);
      const win = m15Bars.map((k, idx) => ({ k, idx })).filter(({ k }) => k.time >= tSigClose && k.time < winEnd);
      let st: GannOctaveState['m15']['status'] = 'waiting';
      let confirmTime: number | null = null;
      let entry15: number | null = null;
      let reasonTxt = '';
      for (const { k, idx } of win) {
        const e = m15Ema[idx];
        if (e == null) continue;
        // 作废优先（保守）：确认前先触及止损
        if (sig.direction === 'long' ? k.low <= o.stop : k.high >= o.stop) {
          st = 'invalidated'; reasonTxt = `确认前价格触及止损${fp0(o.stop)}，信号作废`; break;
        }
        // 同向确认：收盘站上/跌破EMA20 + 同向K线
        const okLong = sig.direction === 'long' && k.close > e && k.close > k.open;
        const okShort = sig.direction === 'short' && k.close < e && k.close < k.open;
        if (okLong || okShort) { st = 'confirmed'; confirmTime = k.time + FIFTEEN_MS; entry15 = k.close; break; }
      }
      if (st === 'waiting') {
        const winComplete = win.length > 0 && win[win.length - 1].k.time + FIFTEEN_MS >= winEnd;
        if (winComplete) { st = 'expired'; reasonTxt = `16根15m窗口内未出现同向确认（收盘过EMA20+同向K线），信号过期`; }
        else reasonTxt = `等待15m确认（窗口已过${win.length}/16根，需${sig.direction === 'long' ? '收盘>EMA20阳线' : '收盘<EMA20阴线'}）`;
      }
      if (st === 'confirmed') {
        entryEff = entry15 as number;
        m15 = { available: true, status: 'confirmed', confirmTime, entry: entry15, reason: `15m确认进场 @${fp0(entry15 as number)}（${new Date(confirmTime as number).toISOString().slice(5, 16).replace('T', ' ')} UTC）` };
      } else {
        m15 = { available: true, status: st, confirmTime: null, entry: null, reason: reasonTxt };
      }
    }
    state.m15 = m15;
    // 生效进场价与风险比回写
    const orderEff: GannOctaveOrder = {
      ...o,
      entry: entryEff,
      riskPct: sig.direction === 'long' ? (entryEff - o.stop) / entryEff : (o.stop - entryEff) / entryEff,
    };

    // 后续bar推演：同bar先看止损（保守）
    let outcome: 'tp' | 'sl' | null = null;
    for (let j = sig.barIdx + 1; j < n; j++) {
      const b = bars[j];
      if (sig.direction === 'long') {
        if (b.low <= orderEff.stop) { outcome = 'sl'; break; }
        if (b.high >= orderEff.tp2) { outcome = 'tp'; break; }
      } else {
        if (b.high >= orderEff.stop) { outcome = 'sl'; break; }
        if (b.low <= orderEff.tp2) { outcome = 'tp'; break; }
      }
    }

    state.direction = sig.direction;
    state.signalType = sig.signalType;
    state.order = orderEff;
    state.outcome = outcome;
    // 15m未确认（过期/作废）→ 信号终结不进场，回观望并说明
    if (m15.status === 'expired' || m15.status === 'invalidated') {
      state.status = 'waiting';
      state.waitingReason = `近信号（${sig.pattern}·${sig.direction === 'long' ? '多' : '空'}）${m15.status === 'expired' ? '15m窗口内未确认已过期' : '15m确认前触及止损作废'} — 等待下一次五条件共振`;
    } else if (sig.barIdx === last && !outcome) {
      // 信号就在最新收盘bar：待15m确认（极端波动时暂停）
      if (state.volatilityPaused) {
        state.status = 'waiting';
        state.waitingReason = `信号触发（${sig.pattern}）但ATR为30天均值${(ratioNow as number).toFixed(1)}倍 > ${p.atrVolFilterMult}倍，极端行情暂停开仓`;
      } else {
        state.status = m15.status === 'confirmed' ? 'confirmed' : 'pending';
      }
    } else if (outcome) {
      state.status = 'closed';
    } else {
      state.status = 'filled';
    }
  }

  // ================= 观望原因与推理链 =================
  if (state.status === 'waiting') {
    if (!state.waitingReason) {
      const lvTxt = state.checks.levelTouched
        ? `已触及${octaves[state.checks.levelIdx]?.label ?? ''}分位`
        : `未触及目标分位（${wantDir === 'long' ? '50%/62.5%' : '50%/37.5%'}，现距50%分位 ${(((price - ocsNow[4]) / price) * 100).toFixed(2)}%）`;
      const miss: string[] = [];
      if (!state.checks.levelTouched) miss.push(lvTxt);
      if (!state.checks.patternOk) miss.push('无看涨/看跌K线形态');
      if (state.checks.aiOk === 'none') miss.push('AI置信未达0.65');
      if (!state.checks.rsiOk) miss.push(`RSI${rsi[last] != null ? (rsi[last] as number).toFixed(0) : '—'}不在许可区`);
      if (!state.checks.dailyOk) miss.push(`日线趋势${dNow.trend === 'up' ? '上升(只做多)' : dNow.trend === 'down' ? '下降(只做空)' : '不明'}与方向不符`);
      state.waitingReason = miss.length > 0 ? miss.join(' · ') : '等待信号条件齐备';
    }
  }

  const fp = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 });
  chain.push(
    `波段：低点 ${sl ? fp(sl.price) : '—'}(${sl ? Math.round((n - 1 - sl.idx) / 6) : '—'}天前) ~ 高点 ${sh ? fp(sh.price) : '—'}(${sh ? Math.round((n - 1 - sh.idx) / 6) : '—'}天前) · 枢轴左右各${K}根确认 · 区间宽 ${((rangeNow / price) * 100).toFixed(2)}%`,
    `八分位：0%=${fp(ocsNow[0])} · 37.5%=${fp(ocsNow[3])} · 50%=${fp(ocsNow[4])} · 62.5%=${fp(ocsNow[5])} · 87.5%=${fp(ocsNow[7])} · 100%=${fp(ocsNow[8])}`,
    `日线趋势：${dNow.trend === 'up' ? '上升（价>MA30 ' + (dNow.ma ? fp(dNow.ma) : '—') + '，只做多）' : dNow.trend === 'down' ? '下降（价<MA30 ' + (dNow.ma ? fp(dNow.ma) : '—') + '，只做空）' : '不明'}`,
    `AI模型（${GANN_MODEL_ID}·60棵树·T=${RF_TEMP}）：${aiNow ? `买入${(aiNow.buy * 100).toFixed(0)}% / 卖出${(aiNow.sell * 100).toFixed(0)}% / 观望${(aiNow.hold * 100).toFixed(0)}%` : '特征未就绪'} · 门槛≥${p.aiConfThreshold * 100}%`,
    `RSI(14)=${rsi[last] != null ? (rsi[last] as number).toFixed(1) : '—'} · ATR(14)=${atrNow ? fp(atrNow) : '—'}（30天均值${ratioNow ? (ratioNow * 100).toFixed(0) + '%' : '—'}比）${state.volatilityPaused ? ' · ⚠极端波动暂停开仓' : ''}`,
    `最新K线形态：${patBNow || patSNow || '无已识别形态（锤子/吞没/星线/射击之星）'}`,
  );
  if (state.order && state.status !== 'waiting') {
    const o = state.order;
    const m15txt = state.m15.status === 'confirmed'
      ? `15m已确认进场 @${fp0(state.m15.entry as number)}`
      : state.m15.status === 'bypass'
        ? '15m数据不足·按4h信号价直进'
        : state.m15.status === 'waiting'
          ? state.m15.reason
          : state.m15.status;
    chain.push(
      `信号：${state.signalType === 'breakout' ? '突破追单' : '分位回调'}${state.direction === 'long' ? '做多' : '做空'} 4h价 @${fp(o.entry)} · 止损${fp(o.stop)}（${o.stopSource === 'octave' ? '上一/下一档分位' : '1.5×ATR下限'}，-${(o.riskPct * 100).toFixed(2)}%）· TP1 ${fp(o.tp1)} / TP2 ${fp(o.tp2)}`,
      `15m入场确认：${m15txt}${state.m15.entry != null ? `（生效进场价 ${fp0(state.m15.entry)}）` : ''}`,
      `状态：${state.status === 'pending' ? '信号已触发·等15m确认' : state.status === 'confirmed' ? '15m已确认·待进场' : state.status === 'filled' ? '持仓中（等待TP/SL）' : state.outcome === 'tp' ? '已止盈离场' : '已止损离场'}`,
    );
  }
  chain.push(`口径：${STRATEGY_ID} · ETH 4h主框架 · 单笔最大风险权益2% · 止损距离≥${p.atrStopFloorMult}×ATR · 无回测逻辑（纯实盘规则）`);

  return state;
}

// ==================== AI 信号过滤模型（离线训练 · 权重内嵌） ====================
//
// 训练口径（与策略规格一致）：
// - 数据：ETHUSDT 4h 2999根（2025-04-12 ~ 2026-08-25，Binance）· 有效样本 2939（观望778/买1064/卖1097）
// - 特征21维：收盘价与9个八分位偏离度% / RSI(14) / MACD(12,26,9)柱(占价%) / 布林%B(20,2) /
//   量能变化率(5周期) / ATR(14)(占价%) / 区间内相对位置 /
//   下影线/ATR / 上影线/ATR / 有向实体/ATR / 看涨形态旗标 / 看跌形态旗标 / 3根动量%
//   （形态6维：让模型能在分位处识别反转K线 — 回调信号的AI确认依赖这些特征）
// - 标签：未来3根4h内 涨>1.5%=买入 / 跌>1.5%=卖出 / 否则观望
// - 模型：随机森林60棵·深度5·gini·类加权（时间序前80%训练，后20%时间外验证）
// - 温度校准 T=0.28：RF平均概率锐化 p'_c ∝ p̄_c^(1/T)
//   验证集置信≥0.65 精确率：买 58% / 卖 50%
//   分位触及×AI共振（全样本）：多 8/609 · 空 2/612（共振bar 100% 有真实±1.5%方向波动）
export const GANN_MODEL_ID = 'gann-octave-rf-v3';
const RF_TEMP = 0.28;
const RF_ROOTS: number[] = [
  0,61,116,179,236,299,356,411,472,533,594,657,716,775,836,893,952,1009,1060,1121,1178,1241,1296,1351,1410,1465,
  1522,1579,1634,1689,1748,1807,1870,1929,1988,2049,2108,2165,2224,2285,2342,2401,2456,2511,2574,2627,2684,2743,
  2800,2861,2922,2983,3042,3103,3162,3221,3278,3339,3396,3459,
];
const RF_F: number[] = [
  13,7,13,20,8,-1,-1,2,-1,-1,17,1,-1,-1,-1,16,20,13,-1,-1,4,-1,-1,17,17,-1,-1,20,-1,-1,20,20,13,0,-1,-1,2,-1,-1,
  8,17,-1,-1,13,-1,-1,5,16,10,-1,-1,18,-1,-1,1,17,-1,-1,11,-1,-1,10,8,6,0,9,-1,-1,15,-1,-1,13,12,-1,-1,0,-1,-1,
  2,11,14,-1,-1,9,-1,-1,11,13,-1,-1,0,-1,-1,3,12,14,-1,9,-1,-1,15,20,-1,-1,2,-1,-1,3,-1,3,9,-1,-1,10,-1,-1,2,13,
  8,5,14,-1,-1,2,-1,-1,17,0,-1,-1,20,-1,-1,7,14,6,-1,-1,2,-1,-1,11,6,-1,-1,12,-1,-1,1,9,11,4,-1,-1,12,-1,-1,16,
  20,-1,-1,17,-1,-1,8,9,7,-1,-1,4,-1,-1,12,5,-1,-1,12,-1,-1,8,7,5,6,5,-1,-1,-1,20,-1,20,-1,-1,1,17,15,-1,-1,17,
  -1,-1,2,10,-1,-1,-1,2,20,12,12,-1,-1,15,-1,-1,6,12,-1,-1,5,-1,-1,0,12,1,-1,-1,4,-1,-1,9,3,-1,-1,10,-1,-1,2,5,
  13,2,8,-1,-1,7,-1,-1,11,14,-1,-1,3,-1,-1,11,12,9,-1,-1,13,-1,-1,10,2,-1,-1,13,-1,-1,13,11,2,12,-1,-1,8,-1,-1,
  0,0,-1,-1,2,-1,-1,9,19,9,-1,-1,9,-1,-1,5,20,-1,-1,12,-1,-1,4,6,6,5,6,-1,-1,9,-1,-1,4,20,-1,-1,20,-1,-1,13,16,
  12,-1,-1,1,-1,-1,16,6,-1,-1,13,-1,-1,15,3,9,18,-1,-1,16,-1,-1,15,-1,-1,0,8,0,-1,-1,7,-1,-1,17,-1,3,-1,-1,5,15,
  8,4,6,-1,-1,3,-1,-1,9,17,-1,-1,8,-1,-1,7,7,3,-1,-1,15,-1,-1,8,17,-1,-1,0,-1,-1,3,2,7,-1,20,-1,-1,11,17,-1,-1,
  9,-1,-1,0,20,-1,-1,10,6,-1,-1,-1,13,7,12,14,13,-1,-1,-1,1,5,-1,-1,5,-1,-1,11,0,11,-1,-1,3,-1,-1,6,7,-1,-1,10,
  -1,-1,20,9,6,15,-1,-1,9,-1,-1,17,20,-1,-1,12,-1,-1,10,5,3,-1,-1,16,-1,-1,12,7,-1,-1,17,-1,-1,1,5,5,3,10,-1,-1,
  10,-1,-1,6,6,-1,-1,8,-1,-1,11,17,15,-1,-1,15,-1,-1,14,12,-1,-1,17,-1,-1,3,10,13,0,-1,-1,12,-1,-1,0,1,-1,-1,3,
  -1,-1,13,12,4,-1,-1,-1,16,1,-1,-1,10,-1,-1,14,17,8,5,9,-1,-1,12,-1,-1,16,2,-1,-1,12,-1,-1,12,6,8,-1,-1,6,-1,
  -1,20,7,-1,-1,10,-1,-1,10,17,20,11,-1,-1,7,-1,-1,15,1,-1,-1,-1,13,20,9,-1,-1,7,-1,-1,3,3,-1,-1,5,-1,-1,13,6,0,
  8,8,-1,-1,9,-1,-1,16,11,-1,-1,0,-1,-1,15,14,9,-1,-1,13,-1,-1,7,7,-1,-1,9,-1,-1,1,12,8,13,-1,-1,3,-1,-1,13,11,
  -1,-1,20,-1,-1,0,13,4,-1,-1,2,-1,-1,15,8,-1,-1,1,-1,-1,13,8,10,1,16,-1,-1,-1,7,13,-1,-1,15,-1,-1,11,3,15,-1,
  -1,-1,14,4,-1,-1,2,-1,-1,16,13,12,9,-1,-1,20,-1,-1,1,17,-1,-1,4,-1,-1,8,13,6,-1,-1,11,-1,-1,12,15,-1,-1,9,-1,
  -1,9,3,1,11,16,-1,-1,12,-1,-1,6,12,-1,-1,2,-1,-1,17,13,10,-1,-1,13,-1,-1,16,13,-1,-1,15,-1,-1,4,10,12,12,-1,
  -1,14,-1,-1,7,13,-1,-1,5,-1,-1,9,1,-1,-1,20,6,-1,-1,9,-1,-1,0,6,13,11,5,-1,-1,1,-1,-1,8,5,-1,-1,8,-1,-1,13,4,
  13,-1,-1,3,-1,-1,15,17,-1,-1,11,-1,-1,1,7,7,20,-1,-1,9,-1,-1,20,0,-1,-1,7,-1,-1,7,14,13,-1,-1,-1,4,3,-1,-1,4,
  -1,-1,20,17,5,8,4,-1,-1,16,-1,-1,2,13,-1,-1,9,-1,-1,13,11,12,-1,-1,13,-1,-1,13,15,-1,-1,1,-1,-1,5,1,3,2,-1,-1,
  -1,16,7,-1,-1,0,-1,-1,12,2,-1,-1,20,11,-1,-1,7,-1,-1,8,4,0,6,8,-1,-1,4,-1,-1,7,-1,-1,13,17,5,-1,-1,17,-1,-1,0,
  5,-1,-1,6,-1,-1,11,4,12,11,-1,-1,13,-1,-1,8,16,-1,-1,13,-1,-1,0,7,11,-1,-1,12,-1,-1,3,11,-1,-1,2,-1,-1,4,8,10,
  2,12,-1,-1,1,-1,-1,7,11,-1,-1,6,-1,-1,2,12,11,-1,-1,20,-1,-1,20,0,-1,-1,3,-1,-1,3,5,11,3,-1,-1,17,-1,-1,4,-1,
  7,-1,-1,0,16,-1,4,-1,-1,5,1,-1,-1,-1,1,7,2,20,3,-1,-1,-1,13,6,-1,-1,2,-1,-1,13,11,8,-1,-1,7,-1,-1,12,9,-1,-1,
  14,-1,-1,5,9,16,-1,-1,-1,11,1,9,-1,-1,1,-1,-1,7,6,-1,-1,20,-1,-1,13,10,1,14,4,-1,-1,6,-1,-1,0,-1,0,-1,-1,6,10,
  15,-1,-1,13,-1,-1,0,15,-1,-1,14,-1,-1,8,11,4,13,-1,-1,1,-1,-1,7,10,-1,-1,10,-1,-1,2,9,8,-1,-1,14,-1,-1,13,20,
  -1,-1,10,-1,-1,12,6,10,13,-1,-1,7,10,-1,-1,8,-1,-1,20,13,4,-1,-1,3,-1,-1,12,-1,11,-1,-1,5,7,5,3,-1,-1,0,-1,-1,
  5,13,-1,-1,13,-1,-1,1,15,2,-1,-1,12,-1,-1,4,10,-1,-1,8,-1,-1,13,17,12,9,15,-1,-1,10,-1,-1,6,14,-1,-1,14,-1,-1,
  12,13,8,-1,-1,5,-1,-1,13,11,-1,-1,16,-1,-1,13,8,11,4,-1,-1,12,-1,-1,11,11,-1,-1,14,-1,-1,0,20,15,-1,-1,7,-1,
  -1,12,0,-1,-1,3,-1,-1,8,4,3,5,5,-1,-1,13,-1,-1,-1,8,0,8,-1,-1,12,-1,-1,9,15,-1,-1,3,-1,-1,5,20,11,13,-1,-1,14,
  -1,-1,10,11,-1,-1,4,-1,-1,3,5,17,-1,-1,20,-1,-1,4,-1,10,-1,-1,1,8,13,3,15,-1,-1,2,-1,-1,9,5,-1,-1,14,-1,-1,17,
  12,13,-1,-1,20,-1,-1,11,18,-1,-1,11,-1,-1,17,9,14,3,-1,-1,15,-1,-1,15,18,-1,-1,0,-1,-1,12,9,3,-1,-1,-1,-1,13,
  6,10,8,5,-1,-1,5,-1,-1,16,-1,12,-1,-1,14,13,5,-1,-1,10,-1,-1,10,4,-1,-1,5,-1,-1,13,7,16,12,-1,-1,17,-1,-1,13,
  17,-1,-1,20,-1,-1,16,8,-1,17,-1,-1,6,15,-1,-1,11,-1,-1,1,6,3,6,-1,3,-1,-1,8,14,-1,-1,7,-1,-1,13,8,1,-1,-1,11,
  -1,-1,11,13,-1,-1,6,-1,-1,1,6,8,-1,-1,17,16,-1,-1,20,-1,-1,17,0,16,-1,-1,-1,3,8,-1,-1,2,-1,-1,0,7,5,11,6,-1,
  -1,-1,12,8,-1,-1,13,-1,-1,12,11,11,-1,-1,11,-1,-1,13,9,-1,-1,20,-1,-1,1,0,0,12,-1,-1,-1,4,20,-1,-1,16,-1,-1,9,
  18,11,-1,-1,-1,10,9,-1,-1,16,-1,-1,13,12,2,-1,13,3,-1,-1,6,-1,-1,7,12,20,-1,-1,7,-1,-1,1,13,-1,-1,8,-1,-1,6,8,
  9,0,-1,-1,6,-1,-1,13,11,-1,-1,15,-1,-1,1,3,14,-1,-1,17,-1,-1,3,8,-1,-1,9,-1,-1,0,12,12,13,5,-1,-1,14,-1,-1,0,
  11,-1,-1,11,-1,-1,13,3,17,-1,-1,20,-1,-1,13,1,-1,-1,14,-1,-1,10,10,16,-1,-1,11,1,-1,-1,13,-1,-1,10,15,13,-1,
  -1,2,-1,-1,6,-1,-1,0,5,13,2,15,-1,-1,6,-1,-1,15,-1,20,-1,-1,20,0,2,-1,-1,11,-1,-1,17,4,-1,-1,2,-1,-1,3,17,7,8,
  -1,-1,17,-1,-1,10,17,-1,-1,-1,20,2,-1,12,-1,-1,6,2,-1,-1,-1,13,12,12,13,14,-1,-1,-1,12,2,-1,-1,11,-1,-1,9,7,9,
  -1,-1,9,-1,-1,8,1,-1,-1,14,-1,-1,12,8,9,-1,1,-1,-1,1,16,-1,-1,0,-1,-1,14,14,5,-1,-1,15,-1,-1,9,5,-1,-1,0,-1,
  -1,0,13,14,1,6,-1,-1,11,-1,-1,9,15,-1,-1,11,-1,-1,7,3,4,-1,-1,16,-1,-1,13,8,-1,-1,6,-1,-1,3,4,20,-1,12,-1,-1,
  3,12,-1,-1,20,-1,-1,0,10,20,-1,-1,0,-1,-1,16,-1,2,-1,-1,20,1,13,7,3,-1,-1,4,-1,-1,6,2,-1,-1,13,-1,-1,13,5,8,
  -1,-1,15,-1,-1,17,16,-1,-1,17,-1,-1,4,2,10,17,-1,-1,7,-1,-1,14,6,-1,-1,7,-1,-1,5,2,1,-1,-1,10,-1,-1,12,0,-1,
  -1,5,-1,-1,12,10,20,13,6,-1,-1,6,-1,-1,0,13,-1,-1,12,-1,-1,0,17,10,-1,-1,5,-1,-1,4,4,-1,-1,-1,8,5,11,-1,15,-1,
  -1,8,14,-1,-1,9,-1,-1,2,8,20,-1,-1,0,-1,-1,0,12,-1,-1,12,-1,-1,10,7,7,8,12,-1,-1,15,-1,-1,14,7,-1,-1,0,-1,-1,
  13,8,1,-1,-1,20,-1,-1,6,10,-1,-1,6,-1,-1,0,5,2,-1,20,-1,-1,14,5,-1,-1,10,-1,-1,3,9,15,-1,-1,20,-1,-1,5,-1,7,
  -1,-1,13,6,14,9,16,-1,-1,8,-1,-1,6,0,-1,-1,7,-1,-1,14,15,15,-1,-1,13,-1,-1,5,13,-1,-1,11,-1,-1,5,14,8,9,-1,-1,
  6,-1,-1,13,12,-1,-1,11,-1,-1,0,10,13,-1,-1,-1,17,2,-1,-1,0,-1,-1,0,17,12,13,3,-1,-1,7,-1,-1,7,20,-1,-1,0,-1,
  -1,12,17,-1,15,-1,-1,4,14,-1,-1,15,-1,-1,4,2,14,8,-1,-1,10,-1,-1,17,4,-1,-1,20,-1,-1,7,12,3,-1,-1,9,-1,-1,2,2,
  -1,-1,-1,0,9,8,0,20,-1,-1,7,-1,-1,1,2,-1,-1,16,-1,-1,12,9,12,-1,-1,2,-1,-1,13,6,-1,-1,15,-1,-1,11,14,7,-1,-1,
  1,4,-1,-1,15,-1,-1,0,5,-1,16,-1,-1,10,5,-1,-1,3,-1,-1,6,12,13,19,1,-1,-1,-1,10,0,-1,-1,3,-1,-1,7,14,6,-1,-1,4,
  -1,-1,13,17,-1,-1,1,-1,-1,10,2,3,7,-1,-1,16,-1,-1,10,17,-1,-1,16,-1,-1,9,10,-1,16,-1,-1,6,4,-1,-1,2,-1,-1,0,
  12,9,12,13,-1,-1,13,-1,-1,11,9,-1,-1,6,-1,-1,6,14,6,-1,-1,5,-1,-1,6,11,-1,-1,17,-1,-1,0,6,17,-1,20,-1,-1,5,14,
  -1,-1,4,-1,-1,11,17,17,-1,-1,0,-1,-1,4,2,-1,-1,1,-1,-1,12,15,5,1,9,-1,-1,8,-1,-1,11,16,-1,-1,7,-1,-1,3,0,-1,
  -1,8,0,-1,-1,-1,9,7,3,12,-1,-1,1,-1,-1,11,10,-1,-1,13,-1,-1,6,3,11,-1,-1,14,-1,-1,10,15,-1,-1,10,-1,-1,13,8,
  12,1,20,-1,-1,8,-1,-1,13,0,-1,-1,-1,13,13,20,-1,-1,12,-1,-1,4,17,-1,-1,5,-1,-1,1,16,11,20,-1,-1,8,-1,-1,20,3,
  -1,-1,2,-1,-1,2,3,10,-1,-1,11,-1,-1,2,-1,17,-1,-1,10,8,13,17,16,-1,-1,9,-1,-1,0,20,-1,-1,16,-1,-1,9,6,9,-1,-1,
  4,-1,-1,12,1,-1,-1,14,-1,-1,12,7,14,-1,-1,5,-1,-1,14,20,17,-1,-1,3,-1,-1,9,8,-1,-1,16,-1,-1,20,0,20,12,12,-1,
  -1,16,-1,-1,5,12,-1,-1,9,-1,-1,14,1,20,-1,-1,-1,2,9,-1,-1,8,-1,-1,6,5,1,-1,10,-1,-1,10,6,-1,-1,0,-1,-1,12,8,
  -1,17,-1,-1,1,-1,6,-1,-1,13,12,10,1,14,-1,-1,16,-1,-1,1,6,-1,-1,5,-1,-1,12,12,5,-1,-1,16,-1,-1,6,16,-1,-1,17,
  -1,-1,4,8,13,2,-1,-1,0,-1,-1,6,11,-1,-1,16,-1,-1,3,11,12,-1,-1,1,-1,-1,3,10,-1,-1,1,-1,-1,5,12,0,11,9,-1,-1,
  14,-1,-1,14,-1,10,-1,-1,6,6,2,-1,-1,15,-1,-1,13,8,-1,-1,8,-1,-1,5,10,3,9,-1,-1,4,-1,-1,11,-1,7,-1,-1,17,-1,10,
  0,-1,-1,15,-1,-1,8,8,10,7,6,-1,-1,11,-1,-1,5,-1,-1,17,16,8,-1,-1,11,-1,-1,20,4,-1,-1,11,-1,-1,5,13,12,10,-1,
  -1,20,-1,-1,1,16,-1,-1,6,-1,-1,3,10,16,-1,-1,5,-1,-1,15,-1,6,-1,-1,1,11,20,13,-1,15,-1,-1,7,5,-1,-1,3,-1,-1,7,
  13,8,-1,-1,7,-1,-1,9,6,-1,-1,11,-1,-1,1,9,12,17,-1,-1,8,-1,-1,18,11,-1,-1,8,-1,-1,1,11,10,-1,-1,16,-1,-1,8,12,
  -1,-1,-1,7,7,4,9,-1,1,-1,-1,16,-1,7,-1,-1,6,16,7,-1,-1,-1,16,13,-1,-1,8,-1,-1,13,8,20,6,-1,-1,8,-1,-1,12,15,
  -1,-1,7,-1,-1,3,12,0,-1,-1,10,-1,-1,15,4,-1,-1,5,-1,-1,12,13,8,15,12,-1,-1,9,-1,-1,3,13,-1,-1,3,-1,-1,3,20,0,
  -1,-1,-1,0,10,-1,-1,13,-1,-1,2,13,6,6,-1,-1,18,-1,-1,8,0,-1,-1,11,-1,-1,7,12,8,-1,-1,13,-1,-1,6,8,-1,-1,11,-1,
  -1,20,13,12,17,8,-1,-1,17,-1,-1,20,10,-1,-1,13,-1,-1,13,15,13,-1,-1,10,-1,-1,11,9,-1,-1,15,-1,-1,7,14,8,4,-1,
  -1,20,-1,-1,14,0,-1,-1,10,-1,-1,2,6,10,-1,-1,9,-1,-1,9,-1,8,-1,-1,8,9,13,4,20,-1,-1,3,-1,-1,16,-1,3,-1,-1,11,
  14,11,-1,-1,1,-1,-1,6,16,-1,-1,10,-1,-1,9,15,13,9,-1,-1,3,-1,-1,13,1,-1,-1,20,-1,-1,10,11,8,-1,-1,10,-1,-1,4,
  17,-1,-1,12,-1,-1,17,0,8,11,10,-1,-1,9,-1,-1,13,6,-1,-1,9,-1,-1,6,10,-1,11,-1,-1,11,17,-1,-1,-1,10,13,6,13,-1,
  -1,15,-1,-1,17,4,-1,-1,17,-1,-1,12,6,6,-1,-1,13,-1,-1,12,16,-1,-1,17,-1,-1,6,13,1,14,7,-1,-1,9,-1,-1,2,20,-1,
  -1,1,-1,-1,7,4,15,-1,-1,18,-1,-1,10,0,-1,-1,6,-1,-1,4,12,4,0,-1,-1,-1,6,20,-1,-1,14,-1,-1,2,9,11,-1,-1,10,-1,
  -1,16,2,-1,-1,0,-1,-1,12,2,0,4,-1,-1,4,14,-1,-1,2,-1,-1,2,17,9,-1,-1,17,-1,-1,20,20,-1,-1,3,-1,-1,0,4,7,3,-1,
  -1,3,-1,-1,13,6,-1,-1,8,-1,-1,20,8,1,-1,-1,4,-1,-1,10,2,-1,-1,20,-1,-1,1,12,15,5,-1,2,-1,-1,0,9,-1,-1,12,-1,
  -1,13,2,17,-1,-1,18,-1,-1,0,1,-1,-1,11,-1,-1,6,8,1,17,-1,-1,-1,13,17,-1,-1,6,-1,-1,15,9,6,-1,-1,7,-1,-1,17,8,
  -1,-1,1,-1,-1,2,6,0,4,3,-1,-1,13,-1,-1,14,13,-1,-1,13,-1,-1,11,8,9,-1,-1,9,-1,-1,17,12,-1,-1,15,-1,-1,6,2,15,
  1,-1,-1,8,-1,-1,17,-1,12,-1,-1,15,13,-1,17,-1,-1,4,-1,8,-1,-1,13,14,0,17,14,-1,-1,15,-1,-1,6,9,-1,-1,6,-1,-1,
  7,13,-1,7,-1,-1,8,20,-1,-1,13,-1,-1,7,7,8,5,-1,-1,10,-1,-1,12,7,-1,-1,7,-1,-1,11,3,10,-1,-1,17,-1,-1,15,12,-1,
  -1,7,-1,-1,13,6,2,12,9,-1,-1,13,-1,-1,6,13,-1,-1,9,-1,-1,4,0,10,-1,-1,5,-1,-1,0,10,-1,-1,17,-1,-1,6,12,12,16,
  -1,-1,2,-1,-1,-1,5,9,13,-1,-1,7,-1,-1,1,1,-1,-1,6,-1,-1,13,11,7,17,0,-1,-1,4,-1,-1,8,6,-1,-1,17,-1,-1,9,14,11,
  -1,-1,9,-1,-1,4,10,-1,-1,13,-1,-1,13,9,12,1,-1,-1,1,-1,-1,15,3,-1,-1,20,-1,-1,8,6,14,-1,-1,20,-1,-1,12,12,-1,
  -1,17,-1,-1,14,0,11,14,6,-1,-1,12,-1,-1,20,13,-1,-1,18,-1,-1,5,14,20,-1,-1,17,-1,-1,17,-1,17,-1,-1,13,2,13,-1,
  -1,9,-1,11,-1,-1,9,1,12,-1,-1,11,-1,-1,10,3,-1,-1,15,-1,-1,
];
const RF_T: number[] = [
  1.76684,-3.00375,1.557,-0.85629,-5.33546,0,1,0.38744,2,3,0.41039,0.35089,4,5,6,0.25957,-1.03322,1.64014,7,8,
  1.92968,9,10,0.14845,-0.44102,11,12,-0.17901,13,14,0.64614,-3.78827,2.68633,-2.59614,15,16,-1.06142,17,18,
  -11.5,0.18377,19,20,2.70758,21,22,4.08252,0.1126,-0.13344,23,24,0,25,26,11.63351,0.01941,27,28,0.91719,29,30,
  0.55992,-6.76356,-11.34114,-5.93732,24.62272,31,32,0.22007,33,34,3.00537,-0.51716,35,36,2.31677,37,38,1.17103,
  0.41766,-0.31776,39,40,53.56551,41,42,0.85247,2.042,43,44,4.16967,45,46,9.02235,-0.58394,0.65352,47,54.40634,
  48,49,0.37554,1.41966,50,51,6.40371,52,53,10.348,54,11.82412,74.94983,55,56,0.83455,57,58,3.13553,1.87152,
  -4.49394,-2.65716,-0.17518,59,60,0.34111,61,62,-0.31299,3.73483,63,64,-1.17606,65,66,-11.77644,-0.5,-16.13587,
  67,68,-2.4183,69,70,0.01058,-8.22549,71,72,-0.55885,73,74,6.36501,58.86682,0.86378,1.16836,75,76,-0.43765,77,
  78,0.35257,0.36804,79,80,0.32616,81,82,-3.43018,53.6826,-6.55506,83,84,2.10341,85,86,-0.53413,6.60523,87,88,
  -0.03431,89,90,-10.54531,-11.61377,-8.94754,-11.73888,-10.5929,91,92,93,-2.86961,94,-1.18227,95,96,2.12916,
  0.01708,0.18799,97,98,0.12458,99,100,8.48434,0.18507,101,102,103,5.11068,0.8887,-0.28414,-0.69127,104,105,
  0.28079,106,107,-4.37713,-0.55885,108,109,-1.048,110,111,17.89207,-0.52292,11.11792,112,113,2.87771,114,115,
  71.09333,13.95452,116,117,0.08403,118,119,3.11421,-5.00688,2.92122,-7.29574,-14.25191,120,121,-9.87896,122,
  123,0.06531,-0.25715,124,125,-2.82888,126,127,0.39544,-0.32512,40.51545,128,129,1.60705,130,131,-0.15007,
  2.75481,132,133,2.04366,134,135,1.8797,0.76188,3.5164,-0.47062,136,137,-3.38497,138,139,9.75941,4.7377,140,
  141,8.94866,142,143,74.68091,0,48.14372,144,145,53.43922,146,147,10.24013,3.7033,148,149,0.42957,150,151,
  5.1536,-4.9785,-11.82093,-14.94451,-24.73426,152,153,29.89641,154,155,-2.62846,0.93986,156,157,-0.91873,158,
  159,1.7873,0.26081,-0.44236,160,161,1.21632,162,163,0.14209,-0.18165,164,165,2.86086,166,167,0.12009,10.7625,
  71.66853,0,168,169,0.29131,170,171,0.05852,172,173,12.51434,6.25079,7.803,174,175,8.06892,176,177,-0.21453,
  178,11.68117,179,180,4.10235,0.38466,-10.53172,-8.13547,-20.54195,181,182,-1.39061,183,184,55.99497,-0.37307,
  185,186,-4.21772,187,188,-7.6393,-11.879,-6.14916,189,190,0.57247,191,192,-3.16796,0.03743,193,194,1.59553,
  195,196,12.43717,6.31467,3.43698,197,2.54707,198,199,0.86797,0.50895,200,201,75.25219,202,203,15.65805,2.6567,
  204,205,1.21592,6.35256,206,207,208,1.76135,-2.8977,-0.43629,0.44388,1.72381,209,210,211,1.26661,-2.86341,212,
  213,-1.32688,214,215,0.51553,1.37369,0.27707,216,217,1.67706,218,219,1.43978,-1.54404,220,221,0.6233,222,223,
  1.41056,34.03949,-10.00954,0.74295,224,225,28.92221,226,227,-0.64494,-0.15298,228,229,-0.62109,230,231,0.5297,
  -3.44195,-7.35139,232,233,0.12868,234,235,0.30672,0.24803,236,237,0.42844,238,239,6.14758,-4.3959,-8.87462,
  -8.41429,-1.03828,240,241,-0.56751,242,243,-8.50832,-9.49336,244,245,-11.54489,246,247,0.82742,-0.33931,
  0.17044,248,249,0.26268,250,251,1.49699,0.29779,252,253,0.03397,254,255,9.05674,0.68899,2.11526,9.70565,256,
  257,-0.47807,258,259,11.03156,8.52513,260,261,4.59841,262,263,2.05865,-0.07528,9.39475,264,265,266,0.20766,
  15.29727,267,268,0.62268,269,270,1.30993,-0.32636,-12.42554,-9.28785,32.11644,271,272,-0.2445,273,274,0.04428,
  1.81612,275,276,0.79781,277,278,-0.58414,-0.00487,-11.63425,279,280,1.33792,281,282,0.6952,-9.04805,283,284,
  -0.29896,285,286,0.6233,0.6467,2.09055,0.8444,287,288,3.03306,289,290,0.19483,8.00637,291,292,293,1.96133,
  4.49031,70.45968,294,295,6.12373,296,297,9.46322,8.62384,298,299,9.98369,300,301,1.79685,-1.02335,1.56829,
  -6.18304,-6.8988,302,303,39.55589,304,305,0.36605,0.27329,306,307,2.20491,308,309,0.29942,1.03012,58.43904,
  310,311,1.44343,312,313,2.37439,-0.78536,314,315,67.53875,316,317,7.16578,-0.56663,-12.25883,3.11847,318,319,
  3.54092,320,321,2.58341,0.16404,322,323,-0.72687,324,325,13.24233,2.15855,5.55044,326,327,6.75031,328,329,
  0.3805,7.12642,330,331,14.6911,332,333,1.76357,-0.55192,-0.35144,5.1136,0.15238,334,335,336,-2.9909,1.40477,
  337,338,0.07155,339,340,0.76488,3.86584,0.34461,341,342,343,1.36953,4.55962,344,345,3.5255,346,347,0.22047,
  3.01692,-0.62267,37.00873,348,349,-0.06,350,351,-3.62516,-0.13918,352,353,-6.10608,354,355,-8.85974,2.60092,
  -10.00954,356,357,0.63431,358,359,-0.33483,0.10451,360,361,74.32123,362,363,58.82925,-4.32867,-7.00356,
  -0.08703,0.20216,364,365,-0.5081,366,367,-10.18791,-0.03533,368,369,-6.51261,370,371,-0.17114,1.93336,
  -0.08308,372,373,2.70133,374,375,0.3266,1.87837,376,377,0.12085,378,379,10.08743,-0.17261,-0.32394,-0.53413,
  380,381,0.69043,382,383,-1.31544,1.11156,384,385,7.04019,386,387,72.2578,15.36529,388,389,2.21999,8.40696,390,
  391,81.7172,392,393,6.83036,-7.87937,2.48381,0.2372,-9.38022,394,395,-6.50908,396,397,-13.26786,-10.05575,398,
  399,-12.95871,400,401,1.77478,-0.32455,1.69345,402,403,0.65877,404,405,0.35319,-0.21277,406,407,0.13448,408,
  409,11.46502,-3.02536,-5.42295,-3.87136,410,411,59.48157,412,413,1.48608,7.77514,414,415,5.52622,416,417,
  -0.02745,0.83897,2.31449,418,419,420,14.22579,11.45507,421,422,17.87859,423,424,1.26934,-0.20101,-3.19751,
  -12.53272,-7.20204,425,426,0.016,427,428,4.52206,1.6307,429,430,64.18851,431,432,2.04963,0.50832,-0.31022,433,
  434,1.41897,435,436,2.81827,0.57247,437,438,10.91002,439,440,7.60113,1.2176,-1.65353,-10.04006,441,442,443,
  0.41035,3.04647,444,445,8.20693,446,447,-0.27279,10.81171,448,449,3.65781,1.00938,450,451,11.3869,452,453,
  -6.90312,-9.63588,-5.93732,-17.63416,-20.19218,454,455,-11.67415,456,457,-15.66816,458,459,2.5284,-0.34408,
  -4.25899,460,461,0.17558,462,463,2.57787,-4.0579,464,465,-7.38198,466,467,0.73885,0.39086,-0.27216,0.14353,
  468,469,1.83719,470,471,-1.80206,0.10432,472,473,1.83394,474,475,12.99381,5.18335,0.76927,476,477,-0.29421,
  478,479,11.66201,0.84435,480,481,17.59122,482,483,5.55044,-7.31534,-0.21924,-8.92957,0.7658,484,485,2.96696,
  486,487,-10.1619,0.27478,488,489,-4.37713,490,491,4.3531,-0.41992,0.49963,492,493,1.67618,494,495,-0.14779,
  7.59645,496,497,3.93752,498,499,9.8756,6.99729,0.78063,7.92394,500,501,0.8055,502,503,8.26503,504,7.20747,505,
  506,15.39159,0.18302,507,10.99895,508,509,14.78331,20.60791,510,511,512,8.91336,-6.07469,-7.11074,0.26817,
  -9.72683,513,514,515,2.68406,-5.23156,516,517,-0.95862,518,519,1.72302,0.56469,-6.23271,520,521,0.82158,522,
  523,-0.55691,59.66502,524,525,1.2551,526,527,0.58367,47.99377,0.26504,528,529,530,0.87003,11.0909,67.68568,
  531,532,15.29727,533,534,7.21172,6.20178,535,536,2.6567,537,538,1.77478,-0.31737,2.39078,-0.5,-6.9491,539,540,
  -4.28098,541,542,5.39774,543,6.46884,544,545,-0.7994,-0.08355,0.10074,546,547,1.24518,548,549,2.3088,0.37394,
  550,551,0.87978,552,553,2.01394,0.06013,-5.38879,2.5983,554,555,0.11488,556,557,-6.58862,-0.07528,558,559,
  -0.19038,560,561,10.56268,69.81166,2.46269,562,563,1.42547,564,565,2.09498,3.65781,566,567,1.01808,568,569,
  -0.42585,-7.65142,-0.89463,2.55445,570,571,-10.86674,-0.13652,572,573,-10.35102,574,575,1.55996,1.85425,
  -1.73972,576,577,4.97811,578,579,-0.67513,580,0.88485,581,582,4.43399,-5.95005,-9.94289,-10.01,583,584,
  2.36136,585,586,-1.68116,1.71355,587,588,1.91463,589,590,9.33982,0.34585,7.8698,591,592,0.08095,593,594,
  8.59576,0.7071,595,596,5.2822,597,598,1.78802,0.1595,-0.31126,47.91977,0.25903,599,600,0.07242,601,602,
  -2.65341,-0.49831,603,604,0.46929,605,606,0.54836,1.66653,3.00025,607,608,-2.94552,609,610,1.44636,0.80671,
  611,612,0.37295,613,614,2.95402,2.8011,0.09812,-6.67583,615,616,-0.55084,617,618,0.89776,0.73113,619,620,
  1.43987,621,622,2.37171,-3.42856,0.25963,623,624,-10.68307,625,626,-0.0391,18.03409,627,628,5.27326,629,630,
  -6.89887,-9.63588,-8.58099,-16.35773,-18.44369,631,632,2.21778,633,634,635,-8.04416,5.66471,-9.39318,636,637,
  1.10279,638,639,54.14194,0.14411,640,641,2.03843,642,643,5.12286,1.11297,0.47394,1.57632,644,645,1.14127,646,
  647,-0.03313,0.45347,648,649,3.66701,650,651,14.38567,5.52368,0.46869,652,653,3.65781,654,655,12.82433,656,
  0.95352,657,658,8.73101,-7.44154,2.54731,-7.58782,0.47208,659,660,-1.21438,661,662,38.88767,-16.7628,663,664,
  0.25276,665,666,-0.2856,0.33787,1.90827,667,668,0.50729,669,670,0.47352,0,671,672,0.82764,673,674,0.53868,
  64.74935,0.73199,5.56413,675,676,0.27902,677,678,0.44737,0,679,680,15.33937,681,682,1.97136,80.95215,8.69798,
  683,684,685,686,1.76142,-1.16229,0.13407,-4.28449,-1.77336,687,688,-2.2595,689,690,0.12928,691,0.51075,692,
  693,0.95161,1.69633,0.99197,694,695,0.03497,696,697,0.25909,2.52813,698,699,2.52929,700,701,2.55913,3.03219,
  0.13816,-0.64486,702,703,-0.56198,704,705,1.98537,0.49645,706,707,3.65781,708,709,0.04816,-13.26786,710,
  -0.79093,711,712,-7.98236,0.06939,713,714,0.32498,715,716,8.76651,-4.98679,-8.41429,-23.63389,717,-14.67231,
  718,719,-7.26463,0.32686,720,721,-5.89141,722,723,1.75174,-4.13115,1.26642,724,725,0.47931,726,727,0.86628,
  2.70927,728,729,3.28282,730,731,11.38195,-1.89877,-10.21162,732,733,-0.0632,0.37899,734,735,2.16511,736,737,
  -0.1348,21.79961,0.19114,738,739,740,11.40042,-2.27811,741,742,14.59463,743,744,9.96198,-6.07469,-8.6232,
  0.30814,-13.05786,745,746,747,-0.53329,-11.96095,748,749,2.57615,750,751,-0.54424,0.22117,0.16678,752,753,
  0.74248,754,755,1.7644,51.16639,756,757,0.83754,758,759,11.38195,10.66865,10.3921,0.1341,760,761,762,2.95295,
  -0.11547,763,764,0.10857,765,766,73.99727,0,0.49197,767,768,769,0.68319,77.80757,770,771,0.58281,772,773,
  1.74924,-0.51853,-1.02681,774,1.61263,4.39395,775,776,-0.16364,777,778,-0.12493,-0.39821,-1.62238,779,780,
  -3.52062,781,782,4.65159,1.48176,783,784,-0.55192,785,786,3.73243,-12.8137,34.83855,-6.26925,787,788,-9.17846,
  789,790,2.81421,0.09395,791,792,0.34944,793,794,11.63351,7.12416,1.48794,795,796,-0.40719,797,798,11.82412,
  6.18885,799,800,78.84113,801,802,10.3839,-0.1414,-0.63833,1.61137,-2.3914,803,804,0.92728,805,806,7.27253,
  0.13725,807,808,0.97037,809,810,1.54376,-1.9448,-0.31741,811,812,1.10095,813,814,2.87735,1.04848,815,816,
  -0.1548,817,818,0.75379,-0.36036,0.05478,819,820,0.95302,15.29727,821,822,1.92086,823,824,1.27614,0.08512,
  2.03677,825,826,8.92711,827,828,5.25078,829,830,10.09157,-6.35946,2.70133,-7.23186,0.18536,831,832,-10.50318,
  833,834,0.08648,835,-4.69227,836,837,1.06603,2.79926,-1.47024,838,839,0.84591,840,841,1.02381,2.85062,842,843,
  5.86998,844,845,10.64583,0.52986,-4.25083,-14.83125,846,847,-0.31573,848,849,0.8872,0.70527,850,851,852,
  2.54024,12.7134,853,-0.06713,854,855,9.66927,12.52588,856,857,858,1.7751,-0.40651,-0.66834,1.55147,0.40899,
  859,860,861,-0.57951,0.15092,862,863,0.73331,864,865,58.91456,-0.47691,35.57466,866,867,48.78272,868,869,
  -0.79522,3.28389,870,871,1.29399,872,873,-0.42496,-12.95871,26.76079,874,-6.55133,875,876,11.11792,0.19569,
  877,878,14.7655,879,880,1.35495,0.13298,-9.64623,881,882,0.18848,883,884,72.07544,3.37799,885,886,12.07472,
  887,888,10.56545,1.72462,0.67988,0.93602,-1.7366,889,890,0.4451,891,892,69.31331,0.07691,893,894,1.25788,895,
  896,-10.63856,-6.24352,-9.31385,897,898,0.05393,899,900,2.10316,1.48482,901,902,-4.58316,903,904,10.36335,
  2.56539,-1.73157,905,0.05655,906,907,8.86389,0.50964,908,909,2.17426,910,911,15.33937,0.78625,2.45158,912,913,
  14.36211,914,915,0.06652,916,14.59463,917,918,1.20954,4.70576,1.67148,-2.9909,-0.66972,919,920,-0.35553,921,
  922,-10.03776,-1.27663,923,924,2.34121,925,926,1.89116,2.303,-4.42261,927,928,0.11682,929,930,-0.03966,
  0.06347,931,932,0.66706,933,934,4.37066,1.40795,-0.27357,0.38487,935,936,-14.28922,937,938,0.65465,-4.58123,
  939,940,-0.22403,941,942,6.99729,8.44116,6.84896,943,944,0.58543,945,946,-0.126,12.46627,947,948,7.76873,949,
  950,-0.29172,0.5532,0.73832,2.20167,1.33792,951,952,-10.91787,953,954,-3.89717,2.37296,955,956,-0.64413,957,
  958,12.61387,-0.03334,0.60793,959,960,3.43471,961,962,10.52754,1.85805,963,964,965,-6.55687,-10.00802,
  -0.17004,966,0.25963,967,968,-6.87584,0.28215,969,970,44.30206,971,972,4.15926,-0.69678,-1.46501,973,974,
  4.81229,975,976,15.65805,0.03264,977,978,-0.06713,979,980,0.26391,-6.18426,-10.17975,-13.26728,-0.18849,981,
  982,0.38652,983,984,0.34475,-8.66578,985,986,5.68429,987,988,1.72047,-3.16796,2.15874,989,990,-1.09377,991,
  992,-1.85018,-0.04627,993,994,3.33709,995,996,11.90493,-1.91791,0.30733,997,-0.11547,998,999,1.23236,-0.74999,
  1000,1001,0.31337,1002,1003,14.73614,76.52853,0.19726,1004,1005,4.50181,1006,1007,11.43233,1008,15.12524,1009,
  1010,1.77102,-0.32543,0.29347,30.19544,0.18239,1011,1012,-3.62581,1013,1014,-1.46774,5.28746,1015,1016,
  -1.78571,1017,1018,1.03012,0.03412,0.01321,1019,1020,1.70341,1021,1022,3.10625,1.5197,1023,1024,0.75493,1025,
  1026,4.91807,-0.35524,-13.72893,33.34207,1027,1028,-8.49087,1029,1030,2.94767,-0.55585,1031,1032,0.35133,1033,
  1034,16.57589,1.01794,2.19354,1035,1036,1037,-0.1348,16.55725,1038,1039,17.99525,1040,1041,9.91183,0.55782,
  -0.5701,2.09477,-0.88854,1042,1043,-11.28828,1044,1045,-6.20893,-5.41527,1046,1047,2.27362,1048,1049,-0.26749,
  0.62952,1050,0.06736,1051,1052,2.90625,0.67988,1053,1054,0.00527,1055,1056,9.18157,7.8497,0.53754,-13.40359,
  1057,1058,-0.14591,1059,1060,-0.49478,6.98215,1061,1062,3.16659,1063,1064,9.95486,0.15853,13.95452,1065,1066,
  76.52853,1067,1068,14.80006,13.83379,1069,1070,1071,9.71966,36.21215,-11.06257,-6.52208,-6.86977,1072,1073,
  -11.4949,1074,1075,-5.42423,-6.6314,1076,1077,0.04279,1078,1079,-0.42214,55.05702,-0.65545,1080,1081,4.63546,
  1082,1083,1.81701,-0.83201,1084,1085,0.05866,1086,1087,0.87886,0.54322,-12.09143,1088,1089,15.6245,2.86704,
  1090,1091,0.33978,1092,1093,11.15661,4.37886,1094,0.16269,1095,1096,0.68827,9.60648,1097,1098,9.05931,1099,
  1100,3.52725,-0.55441,2.01543,0,0.58263,1101,1102,1103,-0.46464,-3.99208,1104,1105,1.61591,1106,1107,-5.98684,
  0.26657,-10.11799,1108,1109,-3.37597,1110,1111,1.77596,0.17437,1112,1113,0.43928,1114,1115,0.66782,8.18011,
  5.77238,3.49497,1116,1117,0.12112,1118,1119,0.33698,-0.2761,1120,1121,0.16995,1122,1123,69.74694,0.83582,1124,
  0.21663,1125,1126,9.12475,8.39175,1127,1128,14.59463,1129,1130,7.33858,-0.41922,56.77848,-0.5774,2.09477,1131,
  1132,1.80859,1133,1134,0.87462,57.94031,1135,1136,2.46402,1137,1138,-5.10176,0.2636,-10.03776,1139,1140,
  -5.04331,1141,1142,-2.23871,0.3581,1143,1144,0.76025,1145,1146,13.24233,-2.61868,-0.73155,1147,1.17344,1148,
  1149,7.65395,0.65459,1150,1151,9.15095,1152,1153,0.73596,-0.31862,-0.56472,1154,1155,17.45943,1156,1157,
  9.47796,11.37958,1158,1159,19.47346,1160,1161,-0.42585,0.24561,-0.98307,-3.57085,28.74849,1162,1163,-5.51656,
  1164,1165,0.8947,0.09689,1166,1167,3.49497,1168,1169,-3.25641,-5.05865,1170,1171,3.22352,7.66885,1172,1173,
  1174,67.89264,-6.07469,-8.70009,0.36028,1175,1176,2.56951,1177,1178,0.75452,-0.25498,1179,1180,2.11723,1181,
  1182,6.71408,9.05674,0.78727,1183,1184,0.92243,1185,1186,0.62268,0.23777,1187,1188,0.82159,1189,1190,1.7873,
  -3.5086,1.01856,0.5937,-0.71558,1191,1192,-4.95789,1193,1194,1.6307,-3.01519,1195,1196,1197,1.69933,1.49227,
  1.23395,1198,1199,0.25411,1200,1201,0.89275,-0.34922,1202,1203,1.53831,1204,1205,10.69934,0.19714,0.09911,
  -0.90109,1206,1207,-11.63834,1208,1209,-3.45914,-5.31138,1210,1211,1.97084,1212,1213,13.83379,10.85048,
  0.55209,1214,1215,0.94527,1216,1217,14.76773,1218,0.43459,1219,1220,0.53601,-6.83072,2.21527,-0.0247,0.045,
  1221,1222,44.67567,1223,1224,-6.71776,-5.61336,1225,1226,0.07788,1227,1228,48.14372,-2.49659,41.86108,1229,
  1230,1.51035,1231,1232,0.38252,6.6046,1233,1234,0.42198,1235,1236,-0.55735,-0.50881,0.5291,1237,1238,2.42972,
  1239,1240,0.49431,0.04461,-0.4829,1241,1242,-0.11046,1243,1244,68.36989,1.37725,1245,1246,0.44893,1247,1248,
  1.28088,8.23737,-0.82834,-0.49791,-0.55629,1249,1250,0.26455,1251,1252,1.29397,-0.24947,1253,1254,57.57758,
  1255,1256,0.51011,7.9092,-2.42709,1257,1258,1259,15.29807,61.21412,1260,1261,2.352,1262,1263,4.10688,-4.67599,
  -6.01696,1264,-0.56861,1265,1266,-0.17922,-4.16624,1267,1268,5.14514,1269,1270,0.31637,2.68333,1271,-0.05881,
  1272,1273,7.54296,1274,6.42577,1275,1276,1.76357,-0.40166,0.05757,0.20512,-0.07183,1277,1278,0.16077,1279,
  1280,2.58685,-2.20753,1281,1282,4.26427,1283,1284,1.21889,0.69594,-2.0302,1285,1286,0.41755,1287,1288,-2.3328,
  0.11784,1289,1290,0.24405,1291,1292,6.53215,-12.61132,2.65554,-7.29574,1293,1294,15.2216,1295,1296,1.64786,
  0.09516,1297,1298,0.49408,1299,1300,10.62228,0.88055,-0.06734,1301,1302,9.72848,1303,1304,11.84475,1.04501,
  1305,1306,15.19701,1307,1308,4.29906,-0.54983,3.89713,0.1801,38.99079,1309,1310,0.63718,1311,1312,0.34475,
  1313,0.38358,1314,1315,-7.44332,-10.41515,-8.89841,1316,1317,0.56411,1318,1319,1.83392,-4.74503,1320,1321,
  -8.29604,1322,1323,8.33089,0.69314,5.77918,66.61151,1324,1325,5.52594,1326,1327,0.89776,1328,5.04874,1329,
  1330,-0.57355,1331,0.42666,23.04002,1332,1333,0.08066,1334,1335,-7.07037,-15.28692,-0.83814,-17.90426,
  -25.10744,1336,1337,0.06531,1338,1339,-10.82031,1340,1341,-0.25276,0.20749,-11.30833,1342,1343,0.36367,1344,
  1345,0.84243,-3.74384,1346,1347,0.20475,1348,1349,2.58036,1.74866,-0.09841,0.13977,1350,1351,0.89472,1352,
  1353,6.65946,0.3192,1354,1355,0.25425,1356,1357,9.70172,0.34895,0.24163,1358,1359,7.16622,1360,1361,0.06203,
  1362,7.85925,1363,1364,2.51645,0.1076,-5.76078,2.53342,1365,0.31616,1366,1367,-12.49543,-12.06113,1368,1369,
  -7.06616,1370,1371,-5.32487,2.0682,-7.37376,1372,1373,-12.3056,1374,1375,51.51703,-0.84948,1376,1377,0.88,
  1378,1379,11.28874,68.96774,-0.53413,0.36203,1380,1381,-7.34088,1382,1383,0,0.82913,1384,1385,4.97736,1386,
  1387,14.91745,0.68132,-0.2021,1388,1389,0.14932,1390,1391,16.10206,0.28537,1392,1393,1394,-8.71591,-11.76507,
  -8.18032,16.65679,1395,-7.40068,1396,1397,0.11777,1398,-12.09555,1399,1400,-10.04338,0.2261,-11.30265,1401,
  1402,1403,0.21294,2.28989,1404,1405,-12.66612,1406,1407,1.88429,-3.48934,-1.3523,-3.48247,1408,1409,-4.6089,
  1410,1411,-0.10517,0.39224,1412,1413,-0.7803,1414,1415,9.8756,-0.32255,7.33112,1416,1417,-0.29997,1418,1419,
  0.05852,11.2125,1420,1421,9.04683,1422,1423,-0.42389,2.15748,1.54394,0.03697,-0.65545,1424,1425,38.45455,1426,
  1427,7.75522,1.78533,1428,1429,10.33098,1430,1431,-6.23097,0.86677,-5.63599,1432,1433,1434,3.05551,-0.70335,
  1435,1436,2.91706,1437,1438,4.8661,1.72481,-0.86821,-4.70291,1439,1440,0,1441,1442,-12.85438,3.11301,1443,
  1444,0.13725,1445,1446,2.78733,0.29444,-2.78636,1447,1448,2.06112,1449,1450,6.93787,4.08172,1451,1452,0.93362,
  1453,1454,1.2646,1.7214,-0.41681,-0.27463,-5.02092,1455,1456,0.20486,1457,1458,-0.13566,-0.18743,1459,1460,
  1.62995,1461,1462,2.58072,0.30977,1.88951,1463,1464,-0.38216,1465,1466,0.3892,38.60685,1467,1468,0.10695,1469,
  1470,3.10732,0.422,-11.63272,-9.31385,1471,1472,2.77668,1473,1474,0.64078,5.66963,1475,1476,-0.06666,1477,
  1478,11.43348,6.00792,0.67013,1479,1480,74.61734,1481,1482,73.55475,1483,11.73351,1484,1485,-6.74007,37.12582,
  2.70133,-8.67743,-1.68909,1486,1487,-6.82913,1488,1489,0.03866,1490,-4.80551,1491,1492,0.37396,0.37269,
  0.26124,1493,1494,6.61913,1495,1496,-7.05938,0.1187,1497,1498,0.65384,1499,1500,53.92317,0.35995,2.06464,
  38.23211,1501,1502,3.25628,1503,1504,1.73434,0.45266,1505,1506,0.53491,1507,1508,0.22565,0.63525,-3.38832,
  1509,1510,-0.22511,1511,1512,7.76999,0.93949,1513,1514,-0.35621,1515,1516,-0.30568,9.2945,-6.56126,0.11793,
  -0.77109,1517,1518,32.68161,1519,1520,1.81726,-0.43469,1521,1522,59.37394,1523,1524,1.82697,-0.33331,1525,
  0.66815,1526,1527,0.85829,-0.66745,1528,1529,1530,0.32411,2.03635,-0.04194,1.69384,1531,1532,0.47923,1533,
  1534,0.6444,0.87308,1535,1536,1.35333,1537,1538,0.93006,8.87482,-4.61249,1539,1540,2.09571,1541,1542,1.37355,
  0.37012,1543,1544,2.33775,1545,1546,-4.57341,2.57973,2.56951,-0.35219,-10.84578,1547,1548,36.65878,1549,1550,
  1.41263,-0.82283,1551,1552,3.82906,1553,1554,-12.8123,-14.89914,0.1622,1555,1556,0,1557,1558,-0.4029,3.72165,
  1559,1560,-7.0889,1561,1562,1.13179,-0.54424,0.84024,0.67698,1563,1564,1565,-2.91114,-2.22096,1566,1567,
  0.51541,1568,1569,10.64635,51.4819,0.51332,1570,1571,0.2414,1572,1573,0.21735,14.63065,1574,1575,14.46504,
  1576,1577,-0.53717,-0.33684,-3.89717,-7.68069,1578,1579,-5.60107,-0.19996,1580,1581,-1.55242,1582,1583,
  1.88894,-0.04412,49.84908,1584,1585,0.02055,1586,1587,2.54707,1.56155,1588,1589,4.59841,1590,1591,6.96964,
  -2.99954,-10.84578,-6.14916,1592,1593,-6.4373,1594,1595,1.69427,-2.73542,1596,1597,-6.98807,1598,1599,2.98045,
  -6.87584,11.28766,1600,1601,6.26023,1602,1603,0.67478,8.30955,1604,1605,3.72773,1606,1607,9.03724,-0.52428,
  0.12769,-5.2028,1608,1.31021,1609,1610,3.05438,38.44586,1611,1612,-0.55735,1613,1614,1.69933,0.58263,-0.27213,
  1615,1616,0,1617,1618,-1.96593,-7.21207,1619,1620,0.48564,1621,1622,2.69658,-6.62229,12.48182,0.18113,1623,
  1624,1625,2.36025,0.00957,1626,1627,-0.42311,1628,1629,0.41125,74.84067,5.86082,1630,1631,4.04309,1632,1633,
  -0.17923,3.00951,1634,1635,14.91745,1636,1637,7.55449,-5.26737,5.17172,-10.26496,-10.32914,1638,1639,2.23984,
  1640,1641,0.38971,2.26427,1642,1643,3.04031,1644,1645,0.55034,-4.77511,47.34257,1646,1647,46.61108,1648,1649,
  0.46213,-0.55664,1650,1651,0.06381,1652,1653,7.46147,10.42723,0.18517,8.80786,1654,1655,-5.03571,1656,1657,
  -0.2095,1658,0.35587,1659,1660,0.19318,1.92086,1661,0.47138,1662,1663,8.89068,1664,7.56993,1665,1666,1.75263,
  0.53049,1.66525,-0.57593,-0.20124,1667,1668,0.06591,1669,1670,-4.56797,40.16828,1671,1672,-2.77452,1673,1674,
  -1.07984,1.1635,1675,-1.12604,1676,1677,-0.37982,-0.37524,1678,1679,1.53991,1680,1681,2.48564,-11.08743,
  -14.00702,-9.45479,1682,1683,-0.74083,1684,1685,-0.55885,-4.25541,1686,1687,-2.75638,1688,1689,0.99758,
  13.90515,0.62953,1690,1691,0.08648,1692,1693,0.27456,1.37355,1694,1695,5.74463,1696,1697,2.10225,1.07271,
  -1.61025,-0.07596,39.60079,1698,1699,1.35129,1700,1701,-2.50022,1.69345,1702,1703,57.23281,1704,1705,5.81421,
  4.41339,0.27696,1706,1707,4.1239,1708,1709,11.62263,0.76291,1710,1711,0.38435,1712,1713,-9.99351,1.31133,
  -0.36813,0.10352,1714,1715,-8.45056,1716,1717,1718,5.4873,47.18837,2.83885,1719,1720,-6.35106,1721,1722,
  13.32313,9.98405,1723,1724,3.77075,1725,1726,1.79271,0.79051,-2.94858,-0.43038,0.59377,1727,1728,-3.50439,
  1729,1730,-3.25175,-1.39648,1731,1732,-0.04286,1733,1734,59.53565,0.92366,0.85755,1735,1736,58.76788,1737,
  1738,2.58082,0.17244,1739,1740,1.69732,1741,1742,2.10158,62.8115,-0.45455,0.85392,1743,1744,0.17606,1745,1746,
  0.14459,7.8582,1747,1748,-0.05677,1749,1750,-13.13791,-9.93494,0.18172,1751,1752,-1.33074,1753,1754,-0.53826,
  -0.73788,1755,1756,0.6442,1757,1758,1.39162,8.43236,0.08384,-0.3012,-4.70291,1759,1760,0.36883,1761,1762,
  1.73968,2.01639,1763,1764,0,1765,1766,4.91807,0.78088,1.62904,1767,1768,-0.52408,1769,1770,-0.66745,1771,
  -0.02433,1772,1773,1.56112,4.39278,1.30729,1774,1775,68.51666,1776,1.10703,1777,1778,77.20297,8.77942,0.4765,
  1779,1780,0.73596,1781,1782,0.7358,13.26214,1783,1784,0.08512,1785,1786,
];
const RF_L: number[] = [
  1,2,3,4,5,0,0,8,0,0,11,12,0,0,0,16,17,18,0,0,21,0,0,24,25,0,0,28,0,0,31,32,33,34,0,0,37,0,0,40,41,0,0,44,0,0,
  47,48,49,0,0,52,0,0,55,56,0,0,59,0,0,62,63,64,65,66,0,0,69,0,0,72,73,0,0,76,0,0,79,80,81,0,0,84,0,0,87,88,0,0,
  91,0,0,94,95,96,0,98,0,0,101,102,0,0,105,0,0,108,0,110,111,0,0,114,0,0,117,118,119,120,121,0,0,124,0,0,127,
  128,0,0,131,0,0,134,135,136,0,0,139,0,0,142,143,0,0,146,0,0,149,150,151,152,0,0,155,0,0,158,159,0,0,162,0,0,
  165,166,167,0,0,170,0,0,173,174,0,0,177,0,0,180,181,182,183,184,0,0,0,188,0,190,0,0,193,194,195,0,0,198,0,0,
  201,202,0,0,0,206,207,208,209,0,0,212,0,0,215,216,0,0,219,0,0,222,223,224,0,0,227,0,0,230,231,0,0,234,0,0,237,
  238,239,240,241,0,0,244,0,0,247,248,0,0,251,0,0,254,255,256,0,0,259,0,0,262,263,0,0,266,0,0,269,270,271,272,0,
  0,275,0,0,278,279,0,0,282,0,0,285,286,287,0,0,290,0,0,293,294,0,0,297,0,0,300,301,302,303,304,0,0,307,0,0,310,
  311,0,0,314,0,0,317,318,319,0,0,322,0,0,325,326,0,0,329,0,0,332,333,334,335,0,0,338,0,0,341,0,0,344,345,346,0,
  0,349,0,0,352,0,354,0,0,357,358,359,360,361,0,0,364,0,0,367,368,0,0,371,0,0,374,375,376,0,0,379,0,0,382,383,0,
  0,386,0,0,389,390,391,0,393,0,0,396,397,0,0,400,0,0,403,404,0,0,407,408,0,0,0,412,413,414,415,416,0,0,0,420,
  421,0,0,424,0,0,427,428,429,0,0,432,0,0,435,436,0,0,439,0,0,442,443,444,445,0,0,448,0,0,451,452,0,0,455,0,0,
  458,459,460,0,0,463,0,0,466,467,0,0,470,0,0,473,474,475,476,477,0,0,480,0,0,483,484,0,0,487,0,0,490,491,492,0,
  0,495,0,0,498,499,0,0,502,0,0,505,506,507,508,0,0,511,0,0,514,515,0,0,518,0,0,521,522,523,0,0,0,527,528,0,0,
  531,0,0,534,535,536,537,538,0,0,541,0,0,544,545,0,0,548,0,0,551,552,553,0,0,556,0,0,559,560,0,0,563,0,0,566,
  567,568,569,0,0,572,0,0,575,576,0,0,0,580,581,582,0,0,585,0,0,588,589,0,0,592,0,0,595,596,597,598,599,0,0,602,
  0,0,605,606,0,0,609,0,0,612,613,614,0,0,617,0,0,620,621,0,0,624,0,0,627,628,629,630,0,0,633,0,0,636,637,0,0,
  640,0,0,643,644,645,0,0,648,0,0,651,652,0,0,655,0,0,658,659,660,661,662,0,0,0,666,667,0,0,670,0,0,673,674,675,
  0,0,0,679,680,0,0,683,0,0,686,687,688,689,0,0,692,0,0,695,696,0,0,699,0,0,702,703,704,0,0,707,0,0,710,711,0,0,
  714,0,0,717,718,719,720,721,0,0,724,0,0,727,728,0,0,731,0,0,734,735,736,0,0,739,0,0,742,743,0,0,746,0,0,749,
  750,751,752,0,0,755,0,0,758,759,0,0,762,0,0,765,766,0,0,769,770,0,0,773,0,0,776,777,778,779,780,0,0,783,0,0,
  786,787,0,0,790,0,0,793,794,795,0,0,798,0,0,801,802,0,0,805,0,0,808,809,810,811,0,0,814,0,0,817,818,0,0,821,0,
  0,824,825,826,0,0,0,830,831,0,0,834,0,0,837,838,839,840,841,0,0,844,0,0,847,848,0,0,851,0,0,854,855,856,0,0,
  859,0,0,862,863,0,0,866,0,0,869,870,871,872,0,0,0,876,877,0,0,880,0,0,883,884,0,0,887,888,0,0,891,0,0,894,895,
  896,897,898,0,0,901,0,0,904,0,0,907,908,909,0,0,912,0,0,915,916,0,0,919,0,0,922,923,924,925,0,0,928,0,0,931,
  932,0,0,935,0,0,938,939,940,0,0,943,0,0,946,947,0,0,950,0,0,953,954,955,956,957,0,0,960,0,0,963,964,0,0,967,0,
  0,970,971,972,0,0,975,0,0,978,979,0,0,982,0,0,985,986,987,988,0,0,991,0,0,994,0,996,0,0,999,1000,0,1002,0,0,
  1005,1006,0,0,0,1010,1011,1012,1013,1014,0,0,0,1018,1019,0,0,1022,0,0,1025,1026,1027,0,0,1030,0,0,1033,1034,0,
  0,1037,0,0,1040,1041,1042,0,0,0,1046,1047,1048,0,0,1051,0,0,1054,1055,0,0,1058,0,0,1061,1062,1063,1064,1065,0,
  0,1068,0,0,1071,0,1073,0,0,1076,1077,1078,0,0,1081,0,0,1084,1085,0,0,1088,0,0,1091,1092,1093,1094,0,0,1097,0,
  0,1100,1101,0,0,1104,0,0,1107,1108,1109,0,0,1112,0,0,1115,1116,0,0,1119,0,0,1122,1123,1124,1125,0,0,1128,1129,
  0,0,1132,0,0,1135,1136,1137,0,0,1140,0,0,1143,0,1145,0,0,1148,1149,1150,1151,0,0,1154,0,0,1157,1158,0,0,1161,
  0,0,1164,1165,1166,0,0,1169,0,0,1172,1173,0,0,1176,0,0,1179,1180,1181,1182,1183,0,0,1186,0,0,1189,1190,0,0,
  1193,0,0,1196,1197,1198,0,0,1201,0,0,1204,1205,0,0,1208,0,0,1211,1212,1213,1214,0,0,1217,0,0,1220,1221,0,0,
  1224,0,0,1227,1228,1229,0,0,1232,0,0,1235,1236,0,0,1239,0,0,1242,1243,1244,1245,1246,0,0,1249,0,0,0,1253,1254,
  1255,0,0,1258,0,0,1261,1262,0,0,1265,0,0,1268,1269,1270,1271,0,0,1274,0,0,1277,1278,0,0,1281,0,0,1284,1285,
  1286,0,0,1289,0,0,1292,0,1294,0,0,1297,1298,1299,1300,1301,0,0,1304,0,0,1307,1308,0,0,1311,0,0,1314,1315,1316,
  0,0,1319,0,0,1322,1323,0,0,1326,0,0,1329,1330,1331,1332,0,0,1335,0,0,1338,1339,0,0,1342,0,0,1345,1346,1347,0,
  0,0,0,1352,1353,1354,1355,1356,0,0,1359,0,0,1362,0,1364,0,0,1367,1368,1369,0,0,1372,0,0,1375,1376,0,0,1379,0,
  0,1382,1383,1384,1385,0,0,1388,0,0,1391,1392,0,0,1395,0,0,1398,1399,0,1401,0,0,1404,1405,0,0,1408,0,0,1411,
  1412,1413,1414,0,1416,0,0,1419,1420,0,0,1423,0,0,1426,1427,1428,0,0,1431,0,0,1434,1435,0,0,1438,0,0,1441,1442,
  1443,0,0,1446,1447,0,0,1450,0,0,1453,1454,1455,0,0,0,1459,1460,0,0,1463,0,0,1466,1467,1468,1469,1470,0,0,0,
  1474,1475,0,0,1478,0,0,1481,1482,1483,0,0,1486,0,0,1489,1490,0,0,1493,0,0,1496,1497,1498,1499,0,0,0,1503,1504,
  0,0,1507,0,0,1510,1511,1512,0,0,0,1516,1517,0,0,1520,0,0,1523,1524,1525,0,1527,1528,0,0,1531,0,0,1534,1535,
  1536,0,0,1539,0,0,1542,1543,0,0,1546,0,0,1549,1550,1551,1552,0,0,1555,0,0,1558,1559,0,0,1562,0,0,1565,1566,
  1567,0,0,1570,0,0,1573,1574,0,0,1577,0,0,1580,1581,1582,1583,1584,0,0,1587,0,0,1590,1591,0,0,1594,0,0,1597,
  1598,1599,0,0,1602,0,0,1605,1606,0,0,1609,0,0,1612,1613,1614,0,0,1617,1618,0,0,1621,0,0,1624,1625,1626,0,0,
  1629,0,0,1632,0,0,1635,1636,1637,1638,1639,0,0,1642,0,0,1645,0,1647,0,0,1650,1651,1652,0,0,1655,0,0,1658,1659,
  0,0,1662,0,0,1665,1666,1667,1668,0,0,1671,0,0,1674,1675,0,0,0,1679,1680,0,1682,0,0,1685,1686,0,0,0,1690,1691,
  1692,1693,1694,0,0,0,1698,1699,0,0,1702,0,0,1705,1706,1707,0,0,1710,0,0,1713,1714,0,0,1717,0,0,1720,1721,1722,
  0,1724,0,0,1727,1728,0,0,1731,0,0,1734,1735,1736,0,0,1739,0,0,1742,1743,0,0,1746,0,0,1749,1750,1751,1752,1753,
  0,0,1756,0,0,1759,1760,0,0,1763,0,0,1766,1767,1768,0,0,1771,0,0,1774,1775,0,0,1778,0,0,1781,1782,1783,0,1785,
  0,0,1788,1789,0,0,1792,0,0,1795,1796,1797,0,0,1800,0,0,1803,0,1805,0,0,1808,1809,1810,1811,1812,0,0,1815,0,0,
  1818,1819,0,0,1822,0,0,1825,1826,1827,0,0,1830,0,0,1833,1834,0,0,1837,0,0,1840,1841,1842,1843,0,0,1846,0,0,
  1849,1850,0,0,1853,0,0,1856,1857,1858,0,0,1861,0,0,1864,1865,0,0,1868,0,0,1871,1872,1873,1874,1875,0,0,1878,0,
  0,1881,1882,0,0,1885,0,0,1888,1889,1890,0,0,1893,0,0,1896,1897,0,0,0,1901,1902,1903,0,1905,0,0,1908,1909,0,0,
  1912,0,0,1915,1916,1917,0,0,1920,0,0,1923,1924,0,0,1927,0,0,1930,1931,1932,1933,1934,0,0,1937,0,0,1940,1941,0,
  0,1944,0,0,1947,1948,1949,0,0,1952,0,0,1955,1956,0,0,1959,0,0,1962,1963,1964,0,1966,0,0,1969,1970,0,0,1973,0,
  0,1976,1977,1978,0,0,1981,0,0,1984,0,1986,0,0,1989,1990,1991,1992,1993,0,0,1996,0,0,1999,2000,0,0,2003,0,0,
  2006,2007,2008,0,0,2011,0,0,2014,2015,0,0,2018,0,0,2021,2022,2023,2024,0,0,2027,0,0,2030,2031,0,0,2034,0,0,
  2037,2038,2039,0,0,0,2043,2044,0,0,2047,0,0,2050,2051,2052,2053,2054,0,0,2057,0,0,2060,2061,0,0,2064,0,0,2067,
  2068,0,2070,0,0,2073,2074,0,0,2077,0,0,2080,2081,2082,2083,0,0,2086,0,0,2089,2090,0,0,2093,0,0,2096,2097,2098,
  0,0,2101,0,0,2104,2105,0,0,0,2109,2110,2111,2112,2113,0,0,2116,0,0,2119,2120,0,0,2123,0,0,2126,2127,2128,0,0,
  2131,0,0,2134,2135,0,0,2138,0,0,2141,2142,2143,0,0,2146,2147,0,0,2150,0,0,2153,2154,0,2156,0,0,2159,2160,0,0,
  2163,0,0,2166,2167,2168,2169,2170,0,0,0,2174,2175,0,0,2178,0,0,2181,2182,2183,0,0,2186,0,0,2189,2190,0,0,2193,
  0,0,2196,2197,2198,2199,0,0,2202,0,0,2205,2206,0,0,2209,0,0,2212,2213,0,2215,0,0,2218,2219,0,0,2222,0,0,2225,
  2226,2227,2228,2229,0,0,2232,0,0,2235,2236,0,0,2239,0,0,2242,2243,2244,0,0,2247,0,0,2250,2251,0,0,2254,0,0,
  2257,2258,2259,0,2261,0,0,2264,2265,0,0,2268,0,0,2271,2272,2273,0,0,2276,0,0,2279,2280,0,0,2283,0,0,2286,2287,
  2288,2289,2290,0,0,2293,0,0,2296,2297,0,0,2300,0,0,2303,2304,0,0,2307,2308,0,0,0,2312,2313,2314,2315,0,0,2318,
  0,0,2321,2322,0,0,2325,0,0,2328,2329,2330,0,0,2333,0,0,2336,2337,0,0,2340,0,0,2343,2344,2345,2346,2347,0,0,
  2350,0,0,2353,2354,0,0,0,2358,2359,2360,0,0,2363,0,0,2366,2367,0,0,2370,0,0,2373,2374,2375,2376,0,0,2379,0,0,
  2382,2383,0,0,2386,0,0,2389,2390,2391,0,0,2394,0,0,2397,0,2399,0,0,2402,2403,2404,2405,2406,0,0,2409,0,0,2412,
  2413,0,0,2416,0,0,2419,2420,2421,0,0,2424,0,0,2427,2428,0,0,2431,0,0,2434,2435,2436,0,0,2439,0,0,2442,2443,
  2444,0,0,2447,0,0,2450,2451,0,0,2454,0,0,2457,2458,2459,2460,2461,0,0,2464,0,0,2467,2468,0,0,2471,0,0,2474,
  2475,2476,0,0,0,2480,2481,0,0,2484,0,0,2487,2488,2489,0,2491,0,0,2494,2495,0,0,2498,0,0,2501,2502,0,2504,0,0,
  2507,0,2509,0,0,2512,2513,2514,2515,2516,0,0,2519,0,0,2522,2523,0,0,2526,0,0,2529,2530,2531,0,0,2534,0,0,2537,
  2538,0,0,2541,0,0,2544,2545,2546,2547,0,0,2550,0,0,2553,2554,0,0,2557,0,0,2560,2561,2562,0,0,2565,0,0,2568,
  2569,0,0,2572,0,0,2575,2576,2577,2578,2579,0,0,2582,0,0,2585,0,2587,0,0,2590,2591,2592,0,0,2595,0,0,2598,2599,
  0,0,2602,0,0,2605,2606,2607,2608,0,0,2611,0,0,2614,0,2616,0,0,2619,0,2621,2622,0,0,2625,0,0,2628,2629,2630,
  2631,2632,0,0,2635,0,0,2638,0,0,2641,2642,2643,0,0,2646,0,0,2649,2650,0,0,2653,0,0,2656,2657,2658,2659,0,0,
  2662,0,0,2665,2666,0,0,2669,0,0,2672,2673,2674,0,0,2677,0,0,2680,0,2682,0,0,2685,2686,2687,2688,0,2690,0,0,
  2693,2694,0,0,2697,0,0,2700,2701,2702,0,0,2705,0,0,2708,2709,0,0,2712,0,0,2715,2716,2717,2718,0,0,2721,0,0,
  2724,2725,0,0,2728,0,0,2731,2732,2733,0,0,2736,0,0,2739,2740,0,0,0,2744,2745,2746,2747,0,2749,0,0,2752,0,2754,
  0,0,2757,2758,2759,0,0,0,2763,2764,0,0,2767,0,0,2770,2771,2772,2773,0,0,2776,0,0,2779,2780,0,0,2783,0,0,2786,
  2787,2788,0,0,2791,0,0,2794,2795,0,0,2798,0,0,2801,2802,2803,2804,2805,0,0,2808,0,0,2811,2812,0,0,2815,0,0,
  2818,2819,2820,0,0,0,2824,2825,0,0,2828,0,0,2831,2832,2833,2834,0,0,2837,0,0,2840,2841,0,0,2844,0,0,2847,2848,
  2849,0,0,2852,0,0,2855,2856,0,0,2859,0,0,2862,2863,2864,2865,2866,0,0,2869,0,0,2872,2873,0,0,2876,0,0,2879,
  2880,2881,0,0,2884,0,0,2887,2888,0,0,2891,0,0,2894,2895,2896,2897,0,0,2900,0,0,2903,2904,0,0,2907,0,0,2910,
  2911,2912,0,0,2915,0,0,2918,0,2920,0,0,2923,2924,2925,2926,2927,0,0,2930,0,0,2933,0,2935,0,0,2938,2939,2940,0,
  0,2943,0,0,2946,2947,0,0,2950,0,0,2953,2954,2955,2956,0,0,2959,0,0,2962,2963,0,0,2966,0,0,2969,2970,2971,0,0,
  2974,0,0,2977,2978,0,0,2981,0,0,2984,2985,2986,2987,2988,0,0,2991,0,0,2994,2995,0,0,2998,0,0,3001,3002,0,3004,
  0,0,3007,3008,0,0,0,3012,3013,3014,3015,0,0,3018,0,0,3021,3022,0,0,3025,0,0,3028,3029,3030,0,0,3033,0,0,3036,
  3037,0,0,3040,0,0,3043,3044,3045,3046,3047,0,0,3050,0,0,3053,3054,0,0,3057,0,0,3060,3061,3062,0,0,3065,0,0,
  3068,3069,0,0,3072,0,0,3075,3076,3077,3078,0,0,0,3082,3083,0,0,3086,0,0,3089,3090,3091,0,0,3094,0,0,3097,3098,
  0,0,3101,0,0,3104,3105,3106,3107,0,0,3110,3111,0,0,3114,0,0,3117,3118,3119,0,0,3122,0,0,3125,3126,0,0,3129,0,
  0,3132,3133,3134,3135,0,0,3138,0,0,3141,3142,0,0,3145,0,0,3148,3149,3150,0,0,3153,0,0,3156,3157,0,0,3160,0,0,
  3163,3164,3165,3166,0,3168,0,0,3171,3172,0,0,3175,0,0,3178,3179,3180,0,0,3183,0,0,3186,3187,0,0,3190,0,0,3193,
  3194,3195,3196,0,0,0,3200,3201,0,0,3204,0,0,3207,3208,3209,0,0,3212,0,0,3215,3216,0,0,3219,0,0,3222,3223,3224,
  3225,3226,0,0,3229,0,0,3232,3233,0,0,3236,0,0,3239,3240,3241,0,0,3244,0,0,3247,3248,0,0,3251,0,0,3254,3255,
  3256,3257,0,0,3260,0,0,3263,0,3265,0,0,3268,3269,0,3271,0,0,3274,0,3276,0,0,3279,3280,3281,3282,3283,0,0,3286,
  0,0,3289,3290,0,0,3293,0,0,3296,3297,0,3299,0,0,3302,3303,0,0,3306,0,0,3309,3310,3311,3312,0,0,3315,0,0,3318,
  3319,0,0,3322,0,0,3325,3326,3327,0,0,3330,0,0,3333,3334,0,0,3337,0,0,3340,3341,3342,3343,3344,0,0,3347,0,0,
  3350,3351,0,0,3354,0,0,3357,3358,3359,0,0,3362,0,0,3365,3366,0,0,3369,0,0,3372,3373,3374,3375,0,0,3378,0,0,0,
  3382,3383,3384,0,0,3387,0,0,3390,3391,0,0,3394,0,0,3397,3398,3399,3400,3401,0,0,3404,0,0,3407,3408,0,0,3411,0,
  0,3414,3415,3416,0,0,3419,0,0,3422,3423,0,0,3426,0,0,3429,3430,3431,3432,0,0,3435,0,0,3438,3439,0,0,3442,0,0,
  3445,3446,3447,0,0,3450,0,0,3453,3454,0,0,3457,0,0,3460,3461,3462,3463,3464,0,0,3467,0,0,3470,3471,0,0,3474,0,
  0,3477,3478,3479,0,0,3482,0,0,3485,0,3487,0,0,3490,3491,3492,0,0,3495,0,3497,0,0,3500,3501,3502,0,0,3505,0,0,
  3508,3509,0,0,3512,0,0,
];
const RF_R: number[] = [
  30,15,10,7,6,0,0,9,0,0,14,13,0,0,0,23,20,19,0,0,22,0,0,27,26,0,0,29,0,0,46,39,36,35,0,0,38,0,0,43,42,0,0,45,0,
  0,54,51,50,0,0,53,0,0,58,57,0,0,60,0,0,93,78,71,68,67,0,0,70,0,0,75,74,0,0,77,0,0,86,83,82,0,0,85,0,0,90,89,0,
  0,92,0,0,107,100,97,0,99,0,0,104,103,0,0,106,0,0,109,0,113,112,0,0,115,0,0,148,133,126,123,122,0,0,125,0,0,
  130,129,0,0,132,0,0,141,138,137,0,0,140,0,0,145,144,0,0,147,0,0,164,157,154,153,0,0,156,0,0,161,160,0,0,163,0,
  0,172,169,168,0,0,171,0,0,176,175,0,0,178,0,0,205,192,187,186,185,0,0,0,189,0,191,0,0,200,197,196,0,0,199,0,0,
  204,203,0,0,0,221,214,211,210,0,0,213,0,0,218,217,0,0,220,0,0,229,226,225,0,0,228,0,0,233,232,0,0,235,0,0,268,
  253,246,243,242,0,0,245,0,0,250,249,0,0,252,0,0,261,258,257,0,0,260,0,0,265,264,0,0,267,0,0,284,277,274,273,0,
  0,276,0,0,281,280,0,0,283,0,0,292,289,288,0,0,291,0,0,296,295,0,0,298,0,0,331,316,309,306,305,0,0,308,0,0,313,
  312,0,0,315,0,0,324,321,320,0,0,323,0,0,328,327,0,0,330,0,0,343,340,337,336,0,0,339,0,0,342,0,0,351,348,347,0,
  0,350,0,0,353,0,355,0,0,388,373,366,363,362,0,0,365,0,0,370,369,0,0,372,0,0,381,378,377,0,0,380,0,0,385,384,0,
  0,387,0,0,402,395,392,0,394,0,0,399,398,0,0,401,0,0,406,405,0,0,410,409,0,0,0,441,426,419,418,417,0,0,0,423,
  422,0,0,425,0,0,434,431,430,0,0,433,0,0,438,437,0,0,440,0,0,457,450,447,446,0,0,449,0,0,454,453,0,0,456,0,0,
  465,462,461,0,0,464,0,0,469,468,0,0,471,0,0,504,489,482,479,478,0,0,481,0,0,486,485,0,0,488,0,0,497,494,493,0,
  0,496,0,0,501,500,0,0,503,0,0,520,513,510,509,0,0,512,0,0,517,516,0,0,519,0,0,526,525,524,0,0,0,530,529,0,0,
  532,0,0,565,550,543,540,539,0,0,542,0,0,547,546,0,0,549,0,0,558,555,554,0,0,557,0,0,562,561,0,0,564,0,0,579,
  574,571,570,0,0,573,0,0,578,577,0,0,0,587,584,583,0,0,586,0,0,591,590,0,0,593,0,0,626,611,604,601,600,0,0,603,
  0,0,608,607,0,0,610,0,0,619,616,615,0,0,618,0,0,623,622,0,0,625,0,0,642,635,632,631,0,0,634,0,0,639,638,0,0,
  641,0,0,650,647,646,0,0,649,0,0,654,653,0,0,656,0,0,685,672,665,664,663,0,0,0,669,668,0,0,671,0,0,678,677,676,
  0,0,0,682,681,0,0,684,0,0,701,694,691,690,0,0,693,0,0,698,697,0,0,700,0,0,709,706,705,0,0,708,0,0,713,712,0,0,
  715,0,0,748,733,726,723,722,0,0,725,0,0,730,729,0,0,732,0,0,741,738,737,0,0,740,0,0,745,744,0,0,747,0,0,764,
  757,754,753,0,0,756,0,0,761,760,0,0,763,0,0,768,767,0,0,772,771,0,0,774,0,0,807,792,785,782,781,0,0,784,0,0,
  789,788,0,0,791,0,0,800,797,796,0,0,799,0,0,804,803,0,0,806,0,0,823,816,813,812,0,0,815,0,0,820,819,0,0,822,0,
  0,829,828,827,0,0,0,833,832,0,0,835,0,0,868,853,846,843,842,0,0,845,0,0,850,849,0,0,852,0,0,861,858,857,0,0,
  860,0,0,865,864,0,0,867,0,0,882,875,874,873,0,0,0,879,878,0,0,881,0,0,886,885,0,0,890,889,0,0,892,0,0,921,906,
  903,900,899,0,0,902,0,0,905,0,0,914,911,910,0,0,913,0,0,918,917,0,0,920,0,0,937,930,927,926,0,0,929,0,0,934,
  933,0,0,936,0,0,945,942,941,0,0,944,0,0,949,948,0,0,951,0,0,984,969,962,959,958,0,0,961,0,0,966,965,0,0,968,0,
  0,977,974,973,0,0,976,0,0,981,980,0,0,983,0,0,998,993,990,989,0,0,992,0,0,995,0,997,0,0,1004,1001,0,1003,0,0,
  1008,1007,0,0,0,1039,1024,1017,1016,1015,0,0,0,1021,1020,0,0,1023,0,0,1032,1029,1028,0,0,1031,0,0,1036,1035,0,
  0,1038,0,0,1045,1044,1043,0,0,0,1053,1050,1049,0,0,1052,0,0,1057,1056,0,0,1059,0,0,1090,1075,1070,1067,1066,0,
  0,1069,0,0,1072,0,1074,0,0,1083,1080,1079,0,0,1082,0,0,1087,1086,0,0,1089,0,0,1106,1099,1096,1095,0,0,1098,0,
  0,1103,1102,0,0,1105,0,0,1114,1111,1110,0,0,1113,0,0,1118,1117,0,0,1120,0,0,1147,1134,1127,1126,0,0,1131,1130,
  0,0,1133,0,0,1142,1139,1138,0,0,1141,0,0,1144,0,1146,0,0,1163,1156,1153,1152,0,0,1155,0,0,1160,1159,0,0,1162,
  0,0,1171,1168,1167,0,0,1170,0,0,1175,1174,0,0,1177,0,0,1210,1195,1188,1185,1184,0,0,1187,0,0,1192,1191,0,0,
  1194,0,0,1203,1200,1199,0,0,1202,0,0,1207,1206,0,0,1209,0,0,1226,1219,1216,1215,0,0,1218,0,0,1223,1222,0,0,
  1225,0,0,1234,1231,1230,0,0,1233,0,0,1238,1237,0,0,1240,0,0,1267,1252,1251,1248,1247,0,0,1250,0,0,0,1260,1257,
  1256,0,0,1259,0,0,1264,1263,0,0,1266,0,0,1283,1276,1273,1272,0,0,1275,0,0,1280,1279,0,0,1282,0,0,1291,1288,
  1287,0,0,1290,0,0,1293,0,1295,0,0,1328,1313,1306,1303,1302,0,0,1305,0,0,1310,1309,0,0,1312,0,0,1321,1318,1317,
  0,0,1320,0,0,1325,1324,0,0,1327,0,0,1344,1337,1334,1333,0,0,1336,0,0,1341,1340,0,0,1343,0,0,1350,1349,1348,0,
  0,0,0,1381,1366,1361,1358,1357,0,0,1360,0,0,1363,0,1365,0,0,1374,1371,1370,0,0,1373,0,0,1378,1377,0,0,1380,0,
  0,1397,1390,1387,1386,0,0,1389,0,0,1394,1393,0,0,1396,0,0,1403,1400,0,1402,0,0,1407,1406,0,0,1409,0,0,1440,
  1425,1418,1415,0,1417,0,0,1422,1421,0,0,1424,0,0,1433,1430,1429,0,0,1432,0,0,1437,1436,0,0,1439,0,0,1452,1445,
  1444,0,0,1449,1448,0,0,1451,0,0,1458,1457,1456,0,0,0,1462,1461,0,0,1464,0,0,1495,1480,1473,1472,1471,0,0,0,
  1477,1476,0,0,1479,0,0,1488,1485,1484,0,0,1487,0,0,1492,1491,0,0,1494,0,0,1509,1502,1501,1500,0,0,0,1506,1505,
  0,0,1508,0,0,1515,1514,1513,0,0,0,1519,1518,0,0,1521,0,0,1548,1533,1526,0,1530,1529,0,0,1532,0,0,1541,1538,
  1537,0,0,1540,0,0,1545,1544,0,0,1547,0,0,1564,1557,1554,1553,0,0,1556,0,0,1561,1560,0,0,1563,0,0,1572,1569,
  1568,0,0,1571,0,0,1576,1575,0,0,1578,0,0,1611,1596,1589,1586,1585,0,0,1588,0,0,1593,1592,0,0,1595,0,0,1604,
  1601,1600,0,0,1603,0,0,1608,1607,0,0,1610,0,0,1623,1616,1615,0,0,1620,1619,0,0,1622,0,0,1631,1628,1627,0,0,
  1630,0,0,1633,0,0,1664,1649,1644,1641,1640,0,0,1643,0,0,1646,0,1648,0,0,1657,1654,1653,0,0,1656,0,0,1661,1660,
  0,0,1663,0,0,1678,1673,1670,1669,0,0,1672,0,0,1677,1676,0,0,0,1684,1681,0,1683,0,0,1688,1687,0,0,0,1719,1704,
  1697,1696,1695,0,0,0,1701,1700,0,0,1703,0,0,1712,1709,1708,0,0,1711,0,0,1716,1715,0,0,1718,0,0,1733,1726,1723,
  0,1725,0,0,1730,1729,0,0,1732,0,0,1741,1738,1737,0,0,1740,0,0,1745,1744,0,0,1747,0,0,1780,1765,1758,1755,1754,
  0,0,1757,0,0,1762,1761,0,0,1764,0,0,1773,1770,1769,0,0,1772,0,0,1777,1776,0,0,1779,0,0,1794,1787,1784,0,1786,
  0,0,1791,1790,0,0,1793,0,0,1802,1799,1798,0,0,1801,0,0,1804,0,1806,0,0,1839,1824,1817,1814,1813,0,0,1816,0,0,
  1821,1820,0,0,1823,0,0,1832,1829,1828,0,0,1831,0,0,1836,1835,0,0,1838,0,0,1855,1848,1845,1844,0,0,1847,0,0,
  1852,1851,0,0,1854,0,0,1863,1860,1859,0,0,1862,0,0,1867,1866,0,0,1869,0,0,1900,1887,1880,1877,1876,0,0,1879,0,
  0,1884,1883,0,0,1886,0,0,1895,1892,1891,0,0,1894,0,0,1899,1898,0,0,0,1914,1907,1904,0,1906,0,0,1911,1910,0,0,
  1913,0,0,1922,1919,1918,0,0,1921,0,0,1926,1925,0,0,1928,0,0,1961,1946,1939,1936,1935,0,0,1938,0,0,1943,1942,0,
  0,1945,0,0,1954,1951,1950,0,0,1953,0,0,1958,1957,0,0,1960,0,0,1975,1968,1965,0,1967,0,0,1972,1971,0,0,1974,0,
  0,1983,1980,1979,0,0,1982,0,0,1985,0,1987,0,0,2020,2005,1998,1995,1994,0,0,1997,0,0,2002,2001,0,0,2004,0,0,
  2013,2010,2009,0,0,2012,0,0,2017,2016,0,0,2019,0,0,2036,2029,2026,2025,0,0,2028,0,0,2033,2032,0,0,2035,0,0,
  2042,2041,2040,0,0,0,2046,2045,0,0,2048,0,0,2079,2066,2059,2056,2055,0,0,2058,0,0,2063,2062,0,0,2065,0,0,2072,
  2069,0,2071,0,0,2076,2075,0,0,2078,0,0,2095,2088,2085,2084,0,0,2087,0,0,2092,2091,0,0,2094,0,0,2103,2100,2099,
  0,0,2102,0,0,2107,2106,0,0,0,2140,2125,2118,2115,2114,0,0,2117,0,0,2122,2121,0,0,2124,0,0,2133,2130,2129,0,0,
  2132,0,0,2137,2136,0,0,2139,0,0,2152,2145,2144,0,0,2149,2148,0,0,2151,0,0,2158,2155,0,2157,0,0,2162,2161,0,0,
  2164,0,0,2195,2180,2173,2172,2171,0,0,0,2177,2176,0,0,2179,0,0,2188,2185,2184,0,0,2187,0,0,2192,2191,0,0,2194,
  0,0,2211,2204,2201,2200,0,0,2203,0,0,2208,2207,0,0,2210,0,0,2217,2214,0,2216,0,0,2221,2220,0,0,2223,0,0,2256,
  2241,2234,2231,2230,0,0,2233,0,0,2238,2237,0,0,2240,0,0,2249,2246,2245,0,0,2248,0,0,2253,2252,0,0,2255,0,0,
  2270,2263,2260,0,2262,0,0,2267,2266,0,0,2269,0,0,2278,2275,2274,0,0,2277,0,0,2282,2281,0,0,2284,0,0,2311,2302,
  2295,2292,2291,0,0,2294,0,0,2299,2298,0,0,2301,0,0,2306,2305,0,0,2310,2309,0,0,0,2327,2320,2317,2316,0,0,2319,
  0,0,2324,2323,0,0,2326,0,0,2335,2332,2331,0,0,2334,0,0,2339,2338,0,0,2341,0,0,2372,2357,2352,2349,2348,0,0,
  2351,0,0,2356,2355,0,0,0,2365,2362,2361,0,0,2364,0,0,2369,2368,0,0,2371,0,0,2388,2381,2378,2377,0,0,2380,0,0,
  2385,2384,0,0,2387,0,0,2396,2393,2392,0,0,2395,0,0,2398,0,2400,0,0,2433,2418,2411,2408,2407,0,0,2410,0,0,2415,
  2414,0,0,2417,0,0,2426,2423,2422,0,0,2425,0,0,2430,2429,0,0,2432,0,0,2441,2438,2437,0,0,2440,0,0,2449,2446,
  2445,0,0,2448,0,0,2453,2452,0,0,2455,0,0,2486,2473,2466,2463,2462,0,0,2465,0,0,2470,2469,0,0,2472,0,0,2479,
  2478,2477,0,0,0,2483,2482,0,0,2485,0,0,2500,2493,2490,0,2492,0,0,2497,2496,0,0,2499,0,0,2506,2503,0,2505,0,0,
  2508,0,2510,0,0,2543,2528,2521,2518,2517,0,0,2520,0,0,2525,2524,0,0,2527,0,0,2536,2533,2532,0,0,2535,0,0,2540,
  2539,0,0,2542,0,0,2559,2552,2549,2548,0,0,2551,0,0,2556,2555,0,0,2558,0,0,2567,2564,2563,0,0,2566,0,0,2571,
  2570,0,0,2573,0,0,2604,2589,2584,2581,2580,0,0,2583,0,0,2586,0,2588,0,0,2597,2594,2593,0,0,2596,0,0,2601,2600,
  0,0,2603,0,0,2618,2613,2610,2609,0,0,2612,0,0,2615,0,2617,0,0,2620,0,2624,2623,0,0,2626,0,0,2655,2640,2637,
  2634,2633,0,0,2636,0,0,2639,0,0,2648,2645,2644,0,0,2647,0,0,2652,2651,0,0,2654,0,0,2671,2664,2661,2660,0,0,
  2663,0,0,2668,2667,0,0,2670,0,0,2679,2676,2675,0,0,2678,0,0,2681,0,2683,0,0,2714,2699,2692,2689,0,2691,0,0,
  2696,2695,0,0,2698,0,0,2707,2704,2703,0,0,2706,0,0,2711,2710,0,0,2713,0,0,2730,2723,2720,2719,0,0,2722,0,0,
  2727,2726,0,0,2729,0,0,2738,2735,2734,0,0,2737,0,0,2742,2741,0,0,0,2769,2756,2751,2748,0,2750,0,0,2753,0,2755,
  0,0,2762,2761,2760,0,0,0,2766,2765,0,0,2768,0,0,2785,2778,2775,2774,0,0,2777,0,0,2782,2781,0,0,2784,0,0,2793,
  2790,2789,0,0,2792,0,0,2797,2796,0,0,2799,0,0,2830,2817,2810,2807,2806,0,0,2809,0,0,2814,2813,0,0,2816,0,0,
  2823,2822,2821,0,0,0,2827,2826,0,0,2829,0,0,2846,2839,2836,2835,0,0,2838,0,0,2843,2842,0,0,2845,0,0,2854,2851,
  2850,0,0,2853,0,0,2858,2857,0,0,2860,0,0,2893,2878,2871,2868,2867,0,0,2870,0,0,2875,2874,0,0,2877,0,0,2886,
  2883,2882,0,0,2885,0,0,2890,2889,0,0,2892,0,0,2909,2902,2899,2898,0,0,2901,0,0,2906,2905,0,0,2908,0,0,2917,
  2914,2913,0,0,2916,0,0,2919,0,2921,0,0,2952,2937,2932,2929,2928,0,0,2931,0,0,2934,0,2936,0,0,2945,2942,2941,0,
  0,2944,0,0,2949,2948,0,0,2951,0,0,2968,2961,2958,2957,0,0,2960,0,0,2965,2964,0,0,2967,0,0,2976,2973,2972,0,0,
  2975,0,0,2980,2979,0,0,2982,0,0,3011,3000,2993,2990,2989,0,0,2992,0,0,2997,2996,0,0,2999,0,0,3006,3003,0,3005,
  0,0,3010,3009,0,0,0,3027,3020,3017,3016,0,0,3019,0,0,3024,3023,0,0,3026,0,0,3035,3032,3031,0,0,3034,0,0,3039,
  3038,0,0,3041,0,0,3074,3059,3052,3049,3048,0,0,3051,0,0,3056,3055,0,0,3058,0,0,3067,3064,3063,0,0,3066,0,0,
  3071,3070,0,0,3073,0,0,3088,3081,3080,3079,0,0,0,3085,3084,0,0,3087,0,0,3096,3093,3092,0,0,3095,0,0,3100,3099,
  0,0,3102,0,0,3131,3116,3109,3108,0,0,3113,3112,0,0,3115,0,0,3124,3121,3120,0,0,3123,0,0,3128,3127,0,0,3130,0,
  0,3147,3140,3137,3136,0,0,3139,0,0,3144,3143,0,0,3146,0,0,3155,3152,3151,0,0,3154,0,0,3159,3158,0,0,3161,0,0,
  3192,3177,3170,3167,0,3169,0,0,3174,3173,0,0,3176,0,0,3185,3182,3181,0,0,3184,0,0,3189,3188,0,0,3191,0,0,3206,
  3199,3198,3197,0,0,0,3203,3202,0,0,3205,0,0,3214,3211,3210,0,0,3213,0,0,3218,3217,0,0,3220,0,0,3253,3238,3231,
  3228,3227,0,0,3230,0,0,3235,3234,0,0,3237,0,0,3246,3243,3242,0,0,3245,0,0,3250,3249,0,0,3252,0,0,3267,3262,
  3259,3258,0,0,3261,0,0,3264,0,3266,0,0,3273,3270,0,3272,0,0,3275,0,3277,0,0,3308,3295,3288,3285,3284,0,0,3287,
  0,0,3292,3291,0,0,3294,0,0,3301,3298,0,3300,0,0,3305,3304,0,0,3307,0,0,3324,3317,3314,3313,0,0,3316,0,0,3321,
  3320,0,0,3323,0,0,3332,3329,3328,0,0,3331,0,0,3336,3335,0,0,3338,0,0,3371,3356,3349,3346,3345,0,0,3348,0,0,
  3353,3352,0,0,3355,0,0,3364,3361,3360,0,0,3363,0,0,3368,3367,0,0,3370,0,0,3381,3380,3377,3376,0,0,3379,0,0,0,
  3389,3386,3385,0,0,3388,0,0,3393,3392,0,0,3395,0,0,3428,3413,3406,3403,3402,0,0,3405,0,0,3410,3409,0,0,3412,0,
  0,3421,3418,3417,0,0,3420,0,0,3425,3424,0,0,3427,0,0,3444,3437,3434,3433,0,0,3436,0,0,3441,3440,0,0,3443,0,0,
  3452,3449,3448,0,0,3451,0,0,3456,3455,0,0,3458,0,0,3489,3476,3469,3466,3465,0,0,3468,0,0,3473,3472,0,0,3475,0,
  0,3484,3481,3480,0,0,3483,0,0,3486,0,3488,0,0,3499,3494,3493,0,0,3496,0,3498,0,0,3507,3504,3503,0,0,3506,0,0,
  3511,3510,0,0,3513,0,0,
];
const RF_P: number[] = [
  0.5882,0.1176,0.2941,0.55,0,0.45,0.6116,0.3223,0.0661,0.5556,0.0833,0.3611,0.2414,0.4138,0.3448,0.4151,0.0566,
  0.5283,0.2,0.8,0,0.2143,0.2143,0.5714,0.375,0,0.625,0.4531,0.3333,0.2135,0.2544,0.3947,0.3509,0.5714,0.2857,
  0.1429,0.086,0.3226,0.5914,0.5385,0.4615,0,0.2472,0.427,0.3258,0,0.5,0.5,0.1714,0.4571,0.3714,0,0.3409,0.6591,
  0,0.75,0.25,0.026,0.4805,0.4935,0.2,0.44,0.36,0.2356,0.3446,0.4199,0.0225,0.4607,0.5169,0.0732,0.6341,0.2927,
  0.2836,0.3134,0.403,0.0985,0.4659,0.4356,0.0208,0.4792,0.5,0,0.5185,0.4815,0.0682,0.7273,0.2045,0,0.5429,
  0.4571,0,0.7576,0.2424,0,0.5556,0.4444,0,1,0,0,0.1538,0.8462,0,0.5,0.5,0.4231,0.3077,0.2692,0.1571,0.3857,
  0.4571,0.1364,0.4091,0.4545,0,0.8529,0.1471,0.25,0.125,0.625,0.4304,0.2603,0.3093,0.2589,0.4732,0.2679,0.4286,
  0.4857,0.0857,0.3174,0.3152,0.3674,0.1282,0.4029,0.4689,0.3438,0.2188,0.4375,0.1321,0.5047,0.3632,0,0.6364,
  0.3636,0.8889,0.1111,0,0.625,0,0.375,0,0.52,0.48,0.0694,0.5,0.4306,0.0417,0.0833,0.875,0.3043,0.3478,0.3478,0,
  1,0,0,0,1,0,0.75,0.25,0,0.5385,0.4615,0,0.9444,0.0556,0.2407,0.2963,0.463,0.519,0.2848,0.1962,0.9444,0,0.0556,
  0.6078,0.1373,0.2549,0.25,0.2596,0.4904,0,0.5,0.5,0.1364,0.25,0.6136,0.3783,0.375,0.2467,0,0.5263,0.4737,0,
  0.8,0.2,0,0.1579,0.8421,0,0.9167,0.0833,0.0909,0.2727,0.6364,0,0.44,0.56,0.5139,0.25,0.2361,0.1835,0.4073,
  0.4093,0.1277,0.4681,0.4043,0.3165,0.482,0.2014,0,1,0,0.0625,0.25,0.6875,0.1333,0.2,0.6667,0.3469,0.4082,
  0.2449,0,0.16,0.84,0.0455,0.6364,0.3182,0,0.5135,0.4865,0.1714,0.3143,0.5143,0,0,1,0,0.48,0.52,0.4643,0.1071,
  0.4286,0.2,0.6,0.2,0.0543,0.5217,0.4239,0.1278,0.4389,0.4333,0,0.4493,0.5507,0,0.875,0.125,0,0,1,0,1,0,0,
  0.875,0.125,0.125,0.75,0.125,0,0.4583,0.5417,0.1385,0.3692,0.4923,0.7692,0,0.2308,0.1842,0.2632,0.5526,0,0.45,
  0.55,0,1,0,0,0,1,0.6316,0.1579,0.2105,0.3896,0.3091,0.3013,0.3179,0.3614,0.3207,0.2207,0.3978,0.3815,0,1,0,
  0.0714,0.4286,0.5,0.2874,0.2069,0.5057,0.1614,0.4449,0.3937,0.4667,0.2444,0.2889,0.1429,0,0.8571,0,0.42,0.58,
  0.1379,0.408,0.454,0,0.2,0.8,0,0.7143,0.2857,0,0.8,0.2,0,0.9474,0.0526,0,1,0,0,0.3043,0.6957,0.172,0.5484,
  0.2796,0.2517,0.3377,0.4106,0,0.6,0.4,0,0,1,0,0.6286,0.3714,0,1,0,0.4151,0.0943,0.4906,0.538,0.2342,0.2278,
  0.5455,0.2045,0.25,0.1567,0.3917,0.4516,0.0645,0.6613,0.2742,0.625,0.25,0.125,0.3542,0.3324,0.3134,0.1653,
  0.4298,0.405,0.6667,0,0.3333,0.25,0,0.75,0.2143,0,0.7857,0.3608,0.3299,0.3093,0,0.56,0.44,0.1875,0.425,0.3875,
  0,0,1,0,0.5,0.5,0.0182,0.5818,0.4,0.125,0.4063,0.4688,0,0.7,0.3,0,0.4194,0.5806,0,0.5294,0.4706,0,0.1111,
  0.8889,0,0.6176,0.3824,0,1,0,0,1,0,0,0.28,0.72,0,0.9286,0.0714,0,0.6111,0.3889,0.1994,0.3932,0.4074,0,0.7959,
  0.2041,0,0.6957,0.3043,0.0882,0.5294,0.3824,0.5691,0.1301,0.3008,0.394,0.3125,0.2935,0.3784,0.3919,0.2297,
  0.2364,0.3227,0.4409,0.3045,0.2591,0.4364,0.1233,0.4384,0.4384,0.1869,0.4229,0.3902,0.0167,0.2333,0.75,0.1667,
  0.3333,0.5,0.6154,0,0.3846,0.125,0.5,0.375,0.1538,0.8462,0,0,0.5,0.5,0,0.7273,0.2727,0,0.0909,0.9091,0.137,
  0.4932,0.3699,0,0.8235,0.1765,0,0.2,0.8,0.0667,0.5333,0.4,0,0.3333,0.6667,0,0.7458,0.2542,0,0.0909,0.9091,0,
  0.5313,0.4688,0.1923,0.3846,0.4231,0,0.6087,0.3913,0.2364,0.3527,0.4109,0.3748,0.3074,0.3178,0.093,0.3488,
  0.5581,0.2441,0.4615,0.2943,0,0.36,0.64,0,1,0,0.0612,0.2857,0.6531,0.1458,0.0625,0.7917,0.2792,0.4221,0.2987,
  0.1319,0.3297,0.5385,0,0.25,0.75,0.121,0.4597,0.4194,0,0.9091,0.0909,0,0.5,0.5,0,0.125,0.875,0.2154,0.2923,
  0.4923,0,0,1,0.0649,0.6234,0.3117,0.2,0.6667,0.1333,0.1,0.4,0.5,0,1,0,0,0.7143,0.2857,0,0.2222,0.7778,0,
  0.8462,0.1538,0.6515,0.1212,0.2273,0.4444,0,0.5556,1,0,0,0.3279,0.418,0.2541,0.6377,0.2609,0.1014,0.4082,
  0.2449,0.3469,0.1429,0,0.8571,0,0.3636,0.6364,0.375,0.4063,0.2188,0.4769,0.0769,0.4462,0.3333,0.381,0.2857,
  0.1667,0.3788,0.4545,0.3265,0.5357,0.1378,0.1838,0.375,0.4412,0,0.5789,0.4211,0,0.3492,0.6508,0,0.875,0.125,
  0.4444,0.4444,0.1111,0,0.3077,0.6923,0.1455,0.3091,0.5455,0,0,1,0.4673,0.1869,0.3458,0.1711,0.4291,0.3997,
  0.0625,0.3125,0.625,0,0.75,0.25,0.4091,0.25,0.3409,0.1094,0.3984,0.4922,0,0.3,0.7,0,0.7538,0.2462,0.2308,
  0.3846,0.3846,0,0.4286,0.5714,0,0.7586,0.2414,0,0.4884,0.5116,0.0714,0.1786,0.75,0,0.6154,0.3846,0.2941,
  0.6765,0.0294,0.34,0.24,0.42,0,0.5,0.5,0.1781,0.3744,0.4475,0.1607,0.3482,0.4911,0.2989,0.3587,0.3424,0.4221,
  0.3134,0.2645,0.2439,0.3841,0.372,0.2857,0.4286,0.2857,0.0886,0.4051,0.5063,0,0.0625,0.9375,0,0.6087,0.3913,
  0.2625,0.4437,0.2938,0.0755,0.3774,0.5472,0,0.2188,0.7813,0.1489,0.3723,0.4787,0,0.2593,0.7407,0,0.9333,
  0.0667,0,0.6154,0.3846,0.2093,0.2326,0.5581,0,1,0,0,0.6316,0.3684,0,0.2222,0.7778,0.4375,0.25,0.3125,0,0.5385,
  0.4615,0,0.3529,0.6471,0,0.7273,0.2727,0,0.375,0.625,0,0,1,0,0.5,0.5,0.125,0.875,0,0.1364,0.375,0.4886,0,
  0.7143,0.2857,0.1836,0.2852,0.5313,0.1882,0.4471,0.3647,0,0.3636,0.6364,0.5724,0.2566,0.1711,0.6,0.0667,
  0.3333,0,0,1,0.0833,0.4259,0.4907,0.3293,0.36,0.3107,0,0.6667,0.3333,0.2063,0.3834,0.4103,0.1852,0.2778,0.537,
  0,0.283,0.717,0.2857,0.4762,0.2381,0,1,0,0.1579,0.3684,0.4737,0.7,0.2,0.1,0.0588,0.5882,0.3529,0,1,0,0,0.5333,
  0.4667,0,0.75,0.25,0,1,0,0,0.375,0.625,0.2727,0.5455,0.1818,0,0.9231,0.0769,0,0.5278,0.4722,0.2258,0.6774,
  0.0968,0.7037,0.2963,0,0.4318,0.1818,0.3864,0.5484,0.2661,0.1855,0.2727,0,0.7273,0.5068,0.2603,0.2329,0.0952,
  0.2381,0.6667,0.3235,0.0588,0.6176,0.4328,0.209,0.3582,0.2955,0.5682,0.1364,0.1154,0.6538,0.2308,0.1974,
  0.2763,0.5263,0.1667,0.3125,0.5208,0.0127,0.5443,0.443,0.5,0,0.5,0.1667,0.3889,0.4444,0,0.1,0.9,0,0.5,0.5,
  0.3889,0.4074,0.2037,0.8667,0,0.1333,0.1622,0.2919,0.5459,0.1848,0.4728,0.3424,0.1148,0.4016,0.4836,0.0165,
  0.4959,0.4876,0.1591,0.4318,0.4091,0.0137,0.7397,0.2466,0,0.4,0.6,0.2714,0.3143,0.4143,0,0.4051,0.5949,0,0.72,
  0.28,0.2143,0.3571,0.4286,0,0.3,0.7,0.069,0.4483,0.4828,0.3478,0.2174,0.4348,0,0,1,0.5766,0.3153,0.1081,
  0.7182,0.1091,0.1727,0.7174,0.2174,0.0652,0.3427,0.3396,0.3178,0,0.5,0.5,0.375,0.25,0.375,0.6429,0.3571,0,
  0.2353,0.3529,0.4118,0,0.8333,0.1667,0,0,1,0.0602,0.5663,0.3735,0.0714,0.5714,0.3571,0.5286,0.2286,0.2429,
  0.2091,0.3798,0.4111,0.1099,0.4397,0.4504,0,0.5625,0.4375,0.125,0.75,0.125,0,0,1,0,0.5088,0.4912,0,0.36,0.64,
  0.1429,0.5857,0.2714,0,0.5181,0.4819,0.0909,0.6364,0.2727,0.3774,0.2453,0.3774,0.1149,0.3678,0.5172,0.1068,
  0.4247,0.4685,0,0.5882,0.4118,0,0.375,0.625,0,0.1111,0.8889,0,0.1667,0.8333,0,0.75,0.25,0,0,1,0,0.3,0.7,0.625,
  0.1875,0.1875,0.1574,0.463,0.3796,0.3514,0.25,0.3986,0.2109,0.415,0.3741,0.1409,0.4227,0.4364,0.0137,0.4795,
  0.5068,0.4918,0.212,0.2962,0.2234,0.4005,0.376,0.3696,0.337,0.2935,0.1711,0.5658,0.2632,0,0,1,0.3333,0.5,
  0.1667,0,1,0,0,0.7083,0.2917,0,0,1,0.1,0.26,0.64,0.1844,0.4006,0.415,0.1667,0.7083,0.125,0.375,0.5,0.125,0,
  0.2727,0.7273,0,0.5556,0.4444,0,0.0526,0.9474,0,0.6471,0.3529,0,1,0,0,0.3636,0.6364,0.25,0.3594,0.3906,0,
  0.625,0.375,0.3684,0.6316,0,0,0.5636,0.4364,0,1,0,0,0.6,0.4,0,0.2759,0.7241,0.4928,0.2622,0.245,0.3125,0.1667,
  0.5208,0.2692,0.5769,0.1538,0.2878,0.3472,0.365,0.1584,0.3348,0.5068,0.2725,0.376,0.3515,0,0.4082,0.5918,
  0.1712,0.4247,0.4041,0,1,0,0,0.5918,0.4082,0.0714,0.2619,0.6667,0,0,1,0.4364,0.3636,0.2,0.1871,0.3355,0.4774,
  0.1277,0.4894,0.383,0,0.871,0.129,0.0833,0.8333,0.0833,0.1538,0.1538,0.6923,0,0.2308,0.7692,0,0.4063,0.5938,0,
  0.6981,0.3019,0,0.1176,0.8824,0,0.875,0.125,0,0.2121,0.7879,0,0.7742,0.2258,0,0.2917,0.7083,0.1394,0.4364,
  0.4242,0.437,0.3025,0.2605,0.1465,0.4091,0.4444,0.1493,0.1343,0.7164,0.2432,0.3514,0.4054,0.6949,0.1582,
  0.1469,0.408,0.2759,0.3161,0.2955,0.5,0.2045,0.2581,0.3641,0.3779,0.219,0.427,0.354,0.0256,0.3333,0.641,0,
  0.4783,0.5217,0.0833,0.5833,0.3333,0,1,0,0,0.7,0.3,0.125,0.375,0.5,0.1424,0.3576,0.5,0.0233,0.6512,0.3256,
  0.3478,0.3478,0.3043,0.1951,0.1707,0.6341,0,1,0,0,0.75,0.25,0,0.7857,0.2143,0,0,1,0,0.6111,0.3889,0,0.9333,
  0.0667,0,0.5294,0.4706,0,0,1,0,0.9524,0.0476,0,0.5833,0.4167,0,0.3,0.7,0,0,1,0.1563,0.3281,0.5156,0,0.381,
  0.619,0.3289,0.4474,0.2237,0.1333,0.3889,0.4778,0.1791,0.2985,0.5224,0,1,0,0,0.6613,0.3387,0.0345,0.5,0.4655,
  0.4545,0.0303,0.5152,0.4478,0.2435,0.3087,0.4453,0.292,0.2628,0.0976,0.3415,0.561,0.2273,0.5152,0.2576,0.1327,
  0.3367,0.5306,0.4949,0.2727,0.2323,0.1897,0.3793,0.431,0.1231,0.6308,0.2462,0.1853,0.3772,0.4375,0.3571,
  0.6429,0,0.1333,0.6889,0.1778,0,0,1,0.1,0.2,0.7,0,0.641,0.359,0,0.913,0.087,0,0.5556,0.4444,0,0.0667,0.9333,
  0.2351,0.3227,0.4422,0.0294,0.6471,0.3235,0,0.3,0.7,0,0.6269,0.3731,0.1048,0.4762,0.419,0,0.0714,0.9286,
  0.5459,0.2,0.2541,0.2636,0.4091,0.3273,0.2889,0.3549,0.3562,0.1727,0.3182,0.5091,0.5405,0.1351,0.3243,0.1967,
  0.2951,0.5082,0.0405,0.5811,0.3784,0.2064,0.3853,0.4083,0.7,0.2,0.1,0.2222,0.3333,0.4444,0.0308,0.4923,0.4769,
  0.25,0.3,0.45,0.1429,0.7143,0.1429,0,1,0,0,0.875,0.125,0.2,0.4667,0.3333,0,0.3913,0.6087,0,0.9474,0.0526,0,
  0.42,0.58,0,0.7586,0.2414,0,0.8182,0.1818,0,0.3077,0.6923,0,0.6667,0.3333,0,0.8667,0.1333,0.1617,0.4059,
  0.4323,0.425,0.375,0.2,0,0.3729,0.6271,0.0909,0.5818,0.3273,0.6471,0.2549,0.098,0.4825,0.1842,0.3333,0.3008,
  0.4675,0.2317,0.226,0.3699,0.4041,0.4545,0.2841,0.2614,0,0.25,0.75,0.1739,0.3813,0.4448,0.0833,0.5119,0.4048,
  0,1,0,0,0.8889,0.1111,0,0.5455,0.4545,0.2105,0.2895,0.5,0.75,0,0.25,0.122,0.3659,0.5122,0,0.5128,0.4872,0,
  0.3143,0.6857,0,0.6364,0.3636,0.087,0.3913,0.5217,0,0.7895,0.2105,0.1818,0.2727,0.5455,0,0,1,0.3235,0.3824,
  0.2941,0.0323,0.5484,0.4194,0,0.125,0.875,0.875,0,0.125,0.0833,0,0.9167,0.78,0.02,0.2,0.483,0.1905,0.3265,
  0.4898,0.449,0.0612,0.4658,0.2534,0.2808,0.1622,0.5135,0.3243,0,0.9167,0.0833,0.4063,0.3359,0.2578,0.2394,
  0.3709,0.3897,0.1628,0.4651,0.3721,0,0.5952,0.4048,0,0.2167,0.7833,0,0.6842,0.3158,0.162,0.3911,0.4469,0.0093,
  0.5888,0.4019,0.1308,0.3318,0.5374,0.22,0.3978,0.3822,0.125,0.6875,0.1875,0,0.7174,0.2826,0.3333,0.2222,
  0.4444,0.2083,0.7917,0,0,0.2917,0.7083,0,1,0,0.069,0.2759,0.6552,0,0.8519,0.1481,0,0,1,0,0.8182,0.1818,0.0952,
  0.5714,0.3333,0,0,1,0.6471,0.2941,0.0588,0,0.9,0.1,0.6379,0.0517,0.3103,0.4593,0.2965,0.2442,0.2832,0.3468,
  0.3699,0.1636,0.2182,0.6182,0.375,0.375,0.25,0,0.2381,0.7619,0,0.9231,0.0769,0,0.7188,0.2813,0,0.1667,0.8333,
  0.1481,0.3981,0.4537,0.0787,0.6457,0.2756,0.4932,0.3041,0.2027,0.2397,0.3288,0.4315,0.2759,0.3339,0.3902,
  0.1307,0.462,0.4073,0,0.4571,0.5429,0.1053,0.3158,0.5789,0.25,0.75,0,0.5,0.0556,0.4444,0,0.2632,0.7368,0.125,
  0.8125,0.0625,0,0.4,0.6,0,0.6719,0.3281,0.7246,0.1159,0.1594,0.4615,0,0.5385,0.65,0.2,0.15,0.3492,0.2222,
  0.4286,0.3529,0.0588,0.5882,0.4087,0.4,0.1913,0.2,0.2,0.6,0.2927,0.372,0.3354,0.3713,0.4251,0.2036,0.2174,
  0.3043,0.4783,0.0625,0.375,0.5625,0.4255,0.1064,0.4681,0.0909,0.6364,0.2727,0,0.4194,0.5806,0.0455,0.5455,
  0.4091,0.3158,0.5789,0.1053,0.1455,0.4,0.4545,0.0225,0.3933,0.5843,0.416,0.328,0.256,0.1709,0.4106,0.4186,0,0,
  1,0.1509,0.4717,0.3774,0.2308,0.2308,0.5385,0,0.7386,0.2614,0,0.5,0.5,0,0.1875,0.8125,0,0.5,0.5,0,1,0,0,
  0.3818,0.6182,0,0.8889,0.1111,0.1786,0.4286,0.3929,0,0.0667,0.9333,0,0.5,0.5,0,0,1,0,0.3333,0.6667,0,0.875,
  0.125,0,0,1,0.2162,0.3288,0.455,0.0137,0.5479,0.4384,0,0.5529,0.4471,0.2727,0.7273,0,0.1379,0.4138,0.4483,
  0.3412,0.4118,0.2471,0.125,0,0.875,0,0.375,0.625,0.5225,0.2297,0.2477,0.269,0.3098,0.4212,0.2943,0.4113,
  0.2943,0.1781,0.2329,0.589,0.1892,0.3243,0.4865,0.0164,0.459,0.5246,0.224,0.306,0.4699,0.2294,0.5229,0.2477,0,
  0.5714,0.4286,0,0.125,0.875,0.0818,0.4636,0.4545,0.0833,0.8611,0.0556,0,0.875,0.125,0,0.3056,0.6944,0,0.9091,
  0.0909,0,0.3125,0.6875,0.1111,0,0.8889,0.1602,0.4144,0.4254,0.3238,0.2762,0.4,0,0.3333,0.6667,0,0.6593,0.3407,
  0.2069,0.4138,0.3793,0,0.4186,0.5814,0.2323,0.3097,0.4581,0.0543,0.4891,0.4565,0.3435,0.2443,0.4122,0,0.25,
  0.75,0.4293,0.3013,0.2693,0.3284,0.1791,0.4925,0.3057,0.4061,0.2882,0.1788,0.4307,0.3905,0,0.8095,0.1905,
  0.1818,0,0.8182,0,0.6786,0.3214,0,0.2083,0.7917,0.0426,0.4362,0.5213,0.4545,0.1818,0.3636,0.4231,0.3846,
  0.1923,0,1,0,0,0.1538,0.8462,0,0.6579,0.3421,0,0.8462,0.1538,0.1111,0.5556,0.3333,0.4885,0.3088,0.2028,0.6333,
  0,0.3667,0.6316,0.0526,0.3158,0.3125,0.2969,0.3906,0.7333,0.1333,0.1333,0.4516,0,0.5484,0,0,1,0.2527,0.4032,
  0.3441,0.377,0.4754,0.1475,0.6923,0,0.3077,0.75,0.25,0,0.2353,0.7059,0.0588,0.2917,0.375,0.3333,0,0.0714,
  0.9286,0.125,0.5341,0.3409,0.5957,0.1915,0.2128,0.1801,0.3199,0.5,0.0625,0.45,0.4875,0.1902,0.4181,0.3917,0,
  0.6,0.4,0,0.8889,0.1111,0.1296,0.2963,0.5741,0.0313,0.8125,0.1563,0,0.8333,0.1667,0,1,0,0,0.1429,0.8571,
  0.0909,0.5455,0.3636,0,0.5493,0.4507,0.2063,0.4921,0.3016,0.0667,0.3944,0.5389,0,0.7778,0.2222,0,0.1111,
  0.8889,0,0.58,0.42,0.1453,0.4302,0.4245,0.02,0.68,0.3,0.4186,0.3953,0.186,0.5833,0,0.4167,0.5811,0.2838,
  0.1351,0.6735,0.0816,0.2449,0.4392,0.2095,0.3514,0.2864,0.4205,0.2932,0.217,0.3422,0.4407,0.0357,0.3571,
  0.6071,0.1148,0.4754,0.4098,0,0.4722,0.5278,0,1,0,0,0.2222,0.7778,0,0.4737,0.5263,0.0833,0.4167,0.5,0.2692,
  0.3077,0.4231,0.2,0.7333,0.0667,0.2727,0.1818,0.5455,0,0,1,0,0.5556,0.4444,0,0.6818,0.3182,0,0.0952,0.9048,0,
  0.7692,0.2308,0,0.4634,0.5366,0,0.7119,0.2881,0,0.3158,0.6842,0.125,0.0625,0.8125,0,0.75,0.25,0.5238,0.2143,
  0.2619,0.2192,0.3269,0.4538,0,0.506,0.494,0.25,0,0.75,0.7692,0.1538,0.0769,0.4692,0.3769,0.1538,0.2927,0.2683,
  0.439,0.4519,0.2478,0.3003,0.269,0.4415,0.2895,0.2014,0.3958,0.4028,0.1211,0.4531,0.4258,0,0.5,0.5,0,0.1111,
  0.8889,0,0.7143,0.2857,0,1,0,0,0.4118,0.5882,0.0769,0,0.9231,0.2143,0.4857,0.3,0,0.1111,0.8889,0.0769,0.5192,
  0.4038,0,0.1429,0.8571,0,0.4,0.6,0,0,1,0,0.6571,0.3429,0,0.2,0.8,0.2,0.1333,0.6667,0.7059,0.2941,0,0.5,0.25,
  0.25,0.7143,0,0.2857,0.125,0,0.875,0.1818,0,0.8182,0.3333,0.2222,0.4444,0.4948,0.299,0.2062,0.3551,0.3302,
  0.3146,0.275,0.5,0.225,0.1667,0.1111,0.7222,0,0.75,0.25,0.165,0.4854,0.3495,0,0.7805,0.2195,0,0.4444,0.5556,
  0.16,0.76,0.08,0.0556,0.3333,0.6111,0.0794,0.373,0.5476,0.2113,0.3995,0.3892,0.1124,0.3034,0.5843,0,0.3396,
  0.6604,0,0.1818,0.8182,0,0.5556,0.4444,0,0.5,0.5,0.2105,0.6316,0.1579,0,0,1,0,0.4286,0.5714,0,0.7949,0.2051,0,
  0.4138,0.5862,0.4444,0,0.5556,0.92,0.08,0,0.4368,0.2299,0.3333,0.0833,0,0.9167,0.1471,0.3039,0.549,0.3443,
  0.3415,0.3142,0.11,0.29,0.6,0,0.6923,0.3077,0.4348,0.3478,0.2174,1,0,0,0.3611,0.4167,0.2222,0.2118,0.3294,
  0.4588,0.1085,0.4031,0.4884,0.1772,0.4242,0.3986,0,0.8056,0.1944,0.069,0.3966,0.5345,0,1,0,0,0.5625,0.4375,
  0.1589,0.3458,0.4953,0,0.3235,0.6765,0,0.625,0.375,0,0.9167,0.0833,0,1,0,0,0.7895,0.2105,0,0.7143,0.2857,0,
  0.4103,0.5897,0,0.6364,0.3636,0.2,0.7333,0.0667,0,0.6667,0.3333,0,0.3636,0.6364,0,0.0952,0.9048,0.2314,0.3802,
  0.3884,0.0769,0.6154,0.3077,0,0.2813,0.7188,0,0.6731,0.3269,0.2442,0.3895,0.3663,0.4136,0.2544,0.332,0.2817,
  0.3717,0.3467,0.0471,0.4353,0.5176,0.1753,0.3506,0.4741,0.2,0.58,0.22,0,0.5238,0.4762,0.2308,0.6923,0.0769,0,
  1,0,0,0.5517,0.4483,0,0.4615,0.5385,0.2237,0.2632,0.5132,0,0.1111,0.8889,0,0.7692,0.2308,0,0.0909,0.9091,0,
  0.1,0.9,0,0.7368,0.2632,0,0.1905,0.8095,0,1,0,0,0.6667,0.3333,0,0.4667,0.5333,0.9091,0,0.0909,0.7778,0,0.2222,
  0.3333,0,0.6667,0.6154,0.2308,0.1538,0.6316,0.3684,0,0.5321,0.2294,0.2385,0.2222,0.3056,0.4722,0.3571,0.1429,
  0.5,0.4134,0.3101,0.2765,0.75,0.125,0.125,0.0556,0.463,0.4815,0.1071,0.7143,0.1786,0,0.3125,0.6875,0.3958,
  0.4583,0.1458,0.1216,0.3919,0.4865,0,0.0833,0.9167,0,1,0,0,0.5385,0.4615,0.3278,0.3167,0.3556,0.1963,0.3458,
  0.4579,0,0,1,0.1364,0.4091,0.4545,0,0.5397,0.4603,0.0765,0.4208,0.5027,0.1055,0.4691,0.4255,0.1816,0.4048,
  0.4136,0,0.7778,0.2222,0,0.4754,0.5246,0.2105,0.6842,0.1053,0,0.68,0.32,0.4583,0.2963,0.2454,0.4667,0.5,
  0.0333,0.4731,0.043,0.4839,0.3947,0.2763,0.3289,0.2931,0.5862,0.1207,0.321,0.2963,0.3827,0.1846,0.5231,0.2923,
  0,0.875,0.125,0,0.4304,0.5696,0,0.0833,0.9167,0,0.9375,0.0625,0.1333,0.5778,0.2889,0.252,0.398,0.35,0.0423,
  0.6761,0.2817,0.1308,0.4626,0.4065,0.1742,0.3118,0.514,0,0.8333,0.1667,0,0.3333,0.6667,0,1,0,0.2029,0.2319,
  0.5652,0,0.4737,0.5263,0.4074,0.4444,0.1481,0.04,0.68,0.28,0.1429,0.3571,0.5,0,1,0,0,0,1,0,0.4,0.6,0,0.2727,
  0.7273,0,1,0,0,0.551,0.449,0.5521,0.3177,0.1302,0.4603,0.254,0.2857,0.5231,0.2462,0.2308,0.2567,0.4385,0.3048,
  0,0.4409,0.5591,0,1,0,0.2694,0.3255,0.4051,0.1492,0.5028,0.3481,0.0769,0,0.9231,0.4444,0.25,0.3056,0.0455,
  0.4091,0.5455,0.2742,0.4032,0.3226,0.1667,0.6667,0.1667,0.0165,0.3554,0.6281,0.1885,0.377,0.4344,0,0.1875,
  0.8125,0,0.7273,0.2727,0,0.3125,0.6875,0,0,1,0.22,0.52,0.26,0.1111,0.4815,0.4074,0.3462,0.0897,0.5641,0.0615,
  0.4154,0.5231,0.2075,0.3585,0.434,0,0.4815,0.5185,0.125,0.65,0.225,0,0.1111,0.8889,0.1333,0.4,0.4667,0,1,0,0,
  0.7368,0.2632,0,0.9231,0.0769,0,0.5,0.5,0.4858,0.2455,0.2687,0.1818,0.2545,0.5636,0.05,0.15,0.8,0.189,0.3622,
  0.4488,0,1,0,0,0.75,0.25,0.6087,0.1304,0.2609,0.1837,0.3469,0.4694,0.1667,0.25,0.5833,0,0.6875,0.3125,0.5294,
  0.4118,0.0588,0.2083,0.4583,0.3333,0,0.4444,0.5556,0,0,1,0,0.7778,0.2222,0,0,1,0,1,0,0,0.3793,0.6207,0.1111,
  0.4444,0.4444,0.0435,0.6667,0.2899,0.1364,0.2727,0.5909,0.4444,0.4444,0.1111,0.1677,0.3806,0.4516,0.3124,
  0.3362,0.3514,0.0541,0.4324,0.5135,0.6,0.2,0.2,0.0725,0.5362,0.3913,0.1886,0.443,0.3684,0,0.8571,0.1429,0,
  0.3548,0.6452,0,0.3721,0.6279,0,0.7619,0.2381,0.1509,0.3585,0.4906,0,0.4516,0.5484,0.3226,0.2581,0.4194,
  0.1299,0.4286,0.4416,0.1429,0.7857,0.0714,0,0.55,0.45,0.498,0.2372,0.2648,0.6429,0.0595,0.2976,0.1136,0.25,
  0.6364,0.3436,0.4089,0.2474,0.189,0.3583,0.4528,0.4405,0.2857,0.2738,0.1565,0.3741,0.4694,0,0.5,0.5,0,0.1333,
  0.8667,0,0.9091,0.0909,0,0.4762,0.5238,0.0769,0.2692,0.6538,0.2674,0.3663,0.3663,0.32,0.32,0.36,0.0774,0.6131,
  0.3095,0.0233,0.3953,0.5814,0.122,0.3415,0.5366,0,0.4706,0.5294,0,1,0,0,1,0,0,0.2308,0.7692,0,0.9167,0.0833,0,
  0.0714,0.9286,0.4091,0.2273,0.3636,0.4861,0.3333,0.1806,0.2,0.3,0.5,0.3821,0.1301,0.4878,0.8235,0,0.1765,0.4,
  0.4286,0.1714,0.3365,0.2404,0.4231,0,1,0,0.7143,0.2857,0,0.2266,0.4609,0.3125,0.6667,0.2222,0.1111,0.087,
  0.4348,0.4783,0,0,1,0.5882,0.1176,0.2941,0.2095,0.4381,0.3524,0,0.6061,0.3939,0,0.2,0.8,0.1639,0.2295,0.6066,
  0.0667,0.5167,0.4167,0.4531,0.2891,0.2578,0.173,0.4353,0.3918,0.0704,0.5634,0.3662,0,0.3571,0.6429,0.0513,
  0.6538,0.2949,0,0.44,0.56,0.2857,0.2143,0.5,0,0,1,0,0.25,0.75,0,0,1,0,0.5952,0.4048,0.6316,0.0789,0.2895,
  0.6038,0.283,0.1132,0,0.2609,0.7391,0.3548,0.3387,0.3065,0,0.451,0.549,0.1404,0.4241,0.4355,0.4,0.3022,0.2978,
  0.2163,0.3632,0.4206,0.6667,0.1111,0.2222,0.5,0.3,0.2,0,0.5714,0.4286,0.0879,0.4176,0.4945,0,0.5769,0.4231,0,
  0.6429,0.3571,0.2113,0.507,0.2817,0,0.75,0.25,0,1,0,0,0.125,0.875,0,0.6522,0.3478,0,0.2727,0.7273,0,1,0,
  0.1798,0.382,0.4382,0,0.5172,0.4828,0,0.3571,0.6429,0,0.8125,0.1875,0,0,1,0,0.4167,0.5833,0,0.9,0.1,0,1,0,0,
  0.5,0.5,0,0.2143,0.7857,0,0.7778,0.2222,0,0.3654,0.6346,0.0667,0.3333,0.6,1,0,0,0.125,0.375,0.5,0,0.6667,
  0.3333,0.2041,0.2653,0.5306,0.5977,0.1379,0.2644,0.4054,0.2741,0.3205,0.1571,0.4714,0.3714,0.4878,0.2927,
  0.2195,0.3844,0.2659,0.3497,0.2412,0.4147,0.3441,0.0349,0.5,0.4651,0.1405,0.4532,0.4064,0,1,0,0.0714,0.5714,
  0.3571,0,0.3125,0.6875,0.2407,0.3611,0.3981,0,0.7407,0.2593,0,0.25,0.75,0,0,1,0,1,0,0.0769,0.4615,0.4615,0,
  0.4444,0.5556,0,0,1,0,0.25,0.75,0,0.7674,0.2326,0.3548,0.3226,0.3226,0.7,0.2222,0.0778,0.25,0,0.75,0.0769,
  0.6154,0.3077,0.5,0.0833,0.4167,0.0244,0.6585,0.3171,0.2564,0.3333,0.4103,0,0.4828,0.5172,0.2257,0.323,0.4514,
  0,0.9333,0.0667,0.0505,0.5758,0.3737,0.3698,0.2744,0.3558,0.3463,0.4436,0.2101,0.0465,0.3372,0.6163,0.1739,
  0.4114,0.4147,0,0.6429,0.3571,0,0.2273,0.7727,0.0625,0.9375,0,0.4048,0.1667,0.4286,0,0.1429,0.8571,0,0.3824,
  0.6176,0.4167,0.3333,0.25,0,0.4688,0.5313,0,1,0,0.1111,0.8889,0,0.125,0.25,0.625,0,0.5,0.5,0,0.1429,0.8571,0,
  0.8095,0.1905,0,0.4706,0.5294,0.6559,0.2581,0.086,0.3273,0.3091,0.3636,0.4758,0.0806,0.4435,0.2295,0.3115,
  0.459,0,0.6,0.4,0.2692,0.4615,0.2692,0,0.6364,0.3636,0,0.375,0.625,0,0.4189,0.5811,0.1946,0.3756,0.4299,0,1,0,
  0.0323,0.7097,0.2581,0.4177,0.2363,0.346,0.2465,0.4366,0.3169,0.2269,0.4229,0.3503,0.039,0.4805,0.4805,0.1111,
  0.6667,0.2222,0,0.4324,0.5676,0,0.9,0.1,0.093,0.2326,0.6744,0.2033,0.4267,0.37,0.0556,0.7778,0.1667,0,0.5172,
  0.4828,0,0.5833,0.4167,0,0.1,0.9,0.2174,0.6087,0.1739,0,0.3077,0.6923,0,0,1,0,0.25,0.75,0,0.5238,0.4762,0,
  0.72,0.28,0,0.25,0.75,0.2381,0.7143,0.0476,0.3871,0.2903,0.3226,0.6712,0.1096,0.2192,0.2692,0.5192,0.2115,
  0.3219,0.2877,0.3904,0,1,0,0.0833,0.0833,0.8333,0,1,0,0,0.1818,0.8182,0.3523,0.1932,0.4545,0,0.037,0.963,0.2,
  0.6667,0.1333,0,0.8846,0.1154,0,0.32,0.68,0.1667,0.4186,0.4147,0.0482,0.5904,0.3614,0.2321,0.2723,0.4955,
  0.274,0.3881,0.3379,0.1233,0.4064,0.4703,0.2639,0.2222,0.5139,0.4375,0.5625,0,0.1776,0.486,0.3364,0,1,0,0,0.5,
  0.5,0.1818,0.7273,0.0909,0,0.2,0.8,0,0.8333,0.1667,0,0.5526,0.4474,0.4912,0.2105,0.2982,0.4516,0.4194,0.129,
  0.5091,0.0182,0.4727,0.4945,0.2967,0.2088,0,0,1,0.2273,0.4545,0.3182,0,0.1,0.9,0.3707,0.4052,0.2241,0.1688,
  0.2857,0.5455,0.2464,0.2826,0.471,0.1333,0.6667,0.2,0.875,0,0.125,0.0909,0,0.9091,0.68,0.28,0.04,0.4583,0.125,
  0.4167,0.1507,0.2329,0.6164,0,0,1,0.0959,0.5342,0.3699,0.247,0.3394,0.4137,0.0682,0.3409,0.5909,0,0.5,0.5,
  0.1643,0.4895,0.3462,0.1103,0.4982,0.3915,0.1143,0.3429,0.5429,0.0377,0.566,0.3962,0,0,1,0,0.9286,0.0714,0,
  0.8889,0.1111,0,0.3684,0.6316,0,0.7273,0.2727,0,0.5385,0.4615,0.2297,0.4054,0.3649,0.4302,0.2558,0.314,0,0.75,
  0.25,0,0.2353,0.7647,0,0.8,0.2,0.0139,0.4444,0.5417,0.1121,0.3738,0.514,0.2899,0.3043,0.4058,0.5022,0.31,
  0.1878,0.2487,0.3057,0.4456,0.7037,0.1111,0.1852,0.2995,0.392,0.3085,0.1311,0.4262,0.4426,0.0323,0.6774,
  0.2903,0.1611,0.3649,0.4739,0,0.5,0.5,0.125,0,0.875,0.8,0.2,0,0.0833,0.6667,0.25,0,1,0,0,0.875,0.125,0,0.25,
  0.75,0,0.125,0.875,0.0685,0.3973,0.5342,0.186,0.3953,0.4186,0,0.5143,0.4857,0.0732,0.6098,0.3171,0.617,0.2128,
  0.1702,0.1481,0.1852,0.6667,0.192,0.3096,0.4985,0.1554,0.4611,0.3834,0.4196,0.2681,0.3124,0.2967,0.4276,
  0.2757,0.3226,0.4032,0.2742,0.0333,0.4667,0.5,0,1,0,0,0.5,0.5,0,1,0,0.0462,0.3538,0.6,0.217,0.3962,0.3868,0,
  0.375,0.625,0,0.875,0.125,0.0667,0.8,0.1333,0,0.3125,0.6875,0,0.76,0.24,0.2308,0.4615,0.3077,0,0.5278,0.4722,
  0.1769,0.2308,0.5923,0.1934,0.3726,0.434,0,0.9231,0.0769,0,0.8261,0.1739,0,0.5,0.5,0,0.2667,0.7333,0.2,0.6667,
  0.1333,0,0.75,0.25,0.2,0.3,0.5,0.7647,0.2353,0,0.6415,0.1887,0.1698,0.6471,0,0.3529,0.7778,0.1111,0.1111,
  0.0769,0.6154,0.3077,0.3404,0.1064,0.5532,0.0667,0.4,0.5333,0.5308,0.2846,0.1846,0.3109,0.3394,0.3497,0.1228,
  0.7544,0.1228,0.5625,0.1875,0.25,0.1538,0,0.8462,0,0.3158,0.6842,0.6429,0.1429,0.2143,0.1316,0.4474,0.4211,0,
  0.875,0.125,0.1489,0.3404,0.5106,0,0.618,0.382,0.0909,0.3636,0.5455,0.0794,0.3254,0.5952,0.2114,0.3783,0.4103,
  0.0286,0.5524,0.419,0.2353,0.4118,0.3529,0.25,0.5714,0.1786,0,0,1,0,0.6,0.4,0,0.8077,0.1923,0,0.05,0.95,0,
  0.5556,0.4444,0,0.9091,0.0909,0,0.5968,0.4032,0.1471,0.4412,0.4118,0.6667,0,0.3333,0.4954,0.4037,0.1009,
  0.2667,0.3333,0.4,0.6923,0,0.3077,0.4906,0.2642,0.2453,0.4333,0.1,0.4667,0,0.6667,0.3333,0,0.2963,0.7037,
  0.1406,0.5,0.3594,0.0625,0.0625,0.875,0.51,0.23,0.26,0.286,0.3712,0.3428,0.05,0.55,0.4,0.1593,0.3802,0.4605,0,
  0.1,0.9,0,0.875,0.125,0.0588,0.1176,0.8235,0.217,0.3868,0.3962,0.0769,0.7692,0.1538,0,0.3077,0.6923,0,0.9,0.1,
  0.0667,0.6,0.3333,0,0.3333,0.6667,0,0.625,0.375,0,0.8333,0.1667,0,0.5385,0.4615,0,1,0,0,0.4762,0.5238,0,0.875,
  0.125,0,1,0,0,0.0769,0.9231,0,0.7333,0.2667,0.0313,0.75,0.2188,0.163,0.3587,0.4783,0,0.375,0.625,0,0.8333,
  0.1667,0.2403,0.2248,0.5349,0.2533,0.4933,0.2533,0,0.1176,0.8824,0.1262,0.534,0.3398,0.4625,0.249,0.2885,
  0.5714,0.0833,0.3452,0.3968,0.3214,0.2817,0.0964,0.4096,0.494,0.2443,0.3552,0.4005,0.1849,0.5137,0.3014,
  0.0192,0.2115,0.7692,0.2667,0.3333,0.4,0.1385,0.4615,0.4,0.3968,0.3016,0.3016,0.1038,0.4863,0.4098,0.04,0.88,
  0.08,0.0667,0.6667,0.2667,0,0.2973,0.7027,0,0.5932,0.4068,0,0.1333,0.8667,0,0.6667,0.3333,0,0.125,0.875,0,
  0.8095,0.1905,0,0.4167,0.5833,0.3448,0.1379,0.5172,0.17,0.395,0.435,0.3,0.325,0.375,0.5106,0.4043,0.0851,0,
  0.5,0.5,0.1657,0.4144,0.4199,0.4459,0.2486,0.3054,0.3529,0.0588,0.5882,0.3306,0.4628,0.2066,0,0.2941,0.7059,
  0.4059,0.3366,0.2574,0.1429,0.1429,0.7143,0.0594,0.5743,0.3663,0.1803,0.3834,0.4363,0.5,0.375,0.125,0.1556,
  0.5333,0.3111,0,0.6875,0.3125,0,0.875,0.125,0.625,0.375,0,0.1818,0.3636,0.4545,0.0952,0.4762,0.4286,0,0.5294,
  0.4706,0,0.64,0.36,0,0.0714,0.9286,0,0.8889,0.1111,0,1,0,0,0.7879,0.2121,0,0.1034,0.8966,0,1,0,0,0.5455,
  0.4545,0,1,0,0,0.125,0.875,0,0.5,0.5,0,0,1,0.3902,0.122,0.4878,0.0328,0.3443,0.623,0.2353,0.7059,0.0588,
  0.0698,0.5349,0.3953,0.34,0.38,0.28,0.3878,0.0612,0.551,0.5652,0.1957,0.2391,0.4312,0.3486,0.2202,0.3391,
  0.2872,0.3737,0.275,0.575,0.15,0.1967,0.3361,0.4672,0.2239,0.4826,0.2935,0.2819,0.3707,0.3475,0.1059,0.3647,
  0.5294,0.0347,0.5556,0.4097,0.1647,0.4047,0.4306,0.4444,0.1111,0.4444,0,0.75,0.25,0,0.2558,0.7442,0,0.5652,
  0.4348,0.7647,0,0.2353,0.7407,0.1481,0.1111,0.1081,0.3514,0.5405,0.5263,0.2348,0.2389,0.4211,0.2105,0.3684,0,
  0.8,0.2,0,0.8889,0.1111,0.125,0.75,0.125,0,0.5833,0.4167,0,0.125,0.875,0,0.8,0.2,0.5789,0.1053,0.3158,0.2,0.5,
  0.3,0.1712,0.3423,0.4865,0,0.4848,0.5152,0.439,0.439,0.122,0.4384,0.2681,0.2935,0.28,0.3733,0.3467,0.1053,
  0.7368,0.1579,0,0.5278,0.4722,0.1176,0.5588,0.3235,0.0978,0.4348,0.4674,0.1621,0.4062,0.4317,0,0.3889,0.6111,
  0.1159,0.6522,0.2319,0.2381,0.5,0.2619,0.3415,0.1951,0.4634,0.0114,0.3977,0.5909,0.1961,0.5098,0.2941,0,
  0.1429,0.8571,0,0.6098,0.3902,0,0.6667,0.3333,0.5385,0.3846,0.0769,0.6053,0.0439,0.3509,0.4412,0.3824,0.1765,
  0.5208,0.2917,0.1875,0.359,0.2692,0.3718,0.2624,0.5068,0.2308,0.7333,0.1667,0.1,0.3759,0.218,0.406,0.2163,
  0.3817,0.402,0.0847,0.3983,0.5169,0.1939,0.4745,0.3316,0.018,0.4685,0.5135,0.2344,0.4219,0.3438,0.0714,0.2857,
  0.6429,0,0.5222,0.4778,0,0.6111,0.3889,0,0.1667,0.8333,0.0806,0.4355,0.4839,0,0.8,0.2,0.3036,0.0357,0.6607,
  0.0714,0.3571,0.5714,0,0.6563,0.3438,0.1963,0.3425,0.4612,0,0.3421,0.6579,0,0.9091,0.0909,0.0556,0.8889,
  0.0556,0.3333,0.3333,0.3333,0,1,0,0,0.4,0.6,0,0.8824,0.1176,0,0.4348,0.5652,0,0.6154,0.3846,0.2941,0.4706,
  0.2353,0.0568,0.4659,0.4773,0,1,0,0,0.4,0.6,0,0.8077,0.1923,0.2121,0.3636,0.4242,0.4286,0.1948,0.3766,0,
  0.9091,0.0909,0,0.4118,0.5882,0,0.4667,0.5333,0,0.8378,0.1622,0.1132,0.5283,0.3585,0.0645,0.0968,0.8387,
  0.2344,0.2344,0.5313,0.4898,0.2573,0.2528,0.2441,0.3307,0.4252,0.0732,0.2439,0.6829,0.7333,0.1,0.1667,0.2169,
  0.3976,0.3855,0.1786,0.4167,0.4048,0,0.7778,0.2222,0.0222,0.3778,0.6,0.194,0.4478,0.3582,0.0238,0.5714,0.4048,
  0.3038,0.3515,0.3447,0.1365,0.372,0.4915,0.0976,0.7073,0.1951,0.1071,0.5714,0.3214,0,0.6098,0.3902,0,0.4468,
  0.5532,0.039,0.3247,0.6364,0,0.1,0.9,0.1587,0.4603,0.381,0.2823,0.2419,0.4758,0.2,0.475,0.325,0.1399,0.3357,
  0.5245,0,0.6842,0.3158,0,1,0,0,0.875,0.125,0,0.4545,0.5455,0,0.35,0.65,0,0,1,0,0.7,0.3,0.5051,0.2677,0.2273,
  0.3008,0.3178,0.3814,0.2935,0.4185,0.288,0.0417,0.7083,0.25,0.2115,0.429,0.3595,0.1182,0.4,0.4818,0,0.5319,
  0.4681,0.0667,0.4,0.5333,0,0.5556,0.4444,0.1933,0.3767,0.43,0.04,0.36,0.6,0,0.8636,0.1364,0,1,0,0,0.75,0.25,
  0.24,0.44,0.32,0,1,0,0,0.5313,0.4688,0.1505,0.3441,0.5054,0.0943,0.2264,0.6792,0.2968,0.3419,0.3613,0.25,
  0.625,0.125,0.7,0.3,0,0,0.9412,0.0588,0,0.7,0.3,0,0.875,0.125,0,0.0625,0.9375,0,0.7021,0.2979,0,1,0,0.2727,
  0.3939,0.3333,0,0.8947,0.1053,0,0.5116,0.4884,0.0476,0.4762,0.4762,0.6,0,0.4,0.5977,0.2299,0.1724,0.5,0.5,0,
  0.1622,0.1351,0.7027,0.3953,0.2093,0.3953,0.3333,0.3496,0.3171,0.1901,0.3264,0.4835,0.3333,0.1569,0.5098,
  0.3191,0.4894,0.1915,0.242,0.4227,0.3353,0.1265,0.5118,0.3618,0.1852,0.2222,0.5926,0,0.3333,0.6667,0,0.8421,
  0.1579,0,0.4082,0.5918,0,0.25,0.75,0,0.75,0.25,0.75,0.25,0,0.25,0.75,0,0.381,0.2381,0.381,0,0.4211,0.5789,
  0.8077,0.1923,0,0.25,0.75,0,1,0,0,0.6591,0.2045,0.1364,0.3645,0.3738,0.2617,0,0.3333,0.6667,0.125,0.875,0,0,1,
  0,0,0.4444,0.5556,0.0833,0.5833,0.3333,0.4872,0.1795,0.3333,0.149,0.3725,0.4784,0.5503,0.302,0.1477,0.2961,
  0.3508,0.3531,0.0405,0.473,0.4865,0.1832,0.4016,0.4152,0,0.5676,0.4324,0,0.0833,0.9167,0.2279,0.3023,0.4698,
  0.0714,0.4603,0.4683,0.1429,0.5102,0.3469,0,0.3125,0.6875,0.1111,0.7778,0.1111,0,0.6364,0.3636,0.3077,0,
  0.6923,0.5294,0.3235,0.1471,0.6111,0.037,0.3519,0.25,0.3125,0.4375,0.5714,0.0612,0.3673,0.338,0.3099,0.3521,0,
  0.8889,0.1111,0.2371,0.3299,0.433,0.677,0.2174,0.1056,0.2901,0.3564,0.3536,0.1212,0.6364,0.2424,0,0.7568,
  0.2432,0.1121,0.5234,0.3645,0.198,0.358,0.444,0.1303,0.4429,0.4269,0,0.4091,0.5909,0,1,0,0,0,1,0.0357,0.3571,
  0.6071,0.25,0.3333,0.4167,0.25,0.25,0.5,0.375,0.125,0.5,0,0.3214,0.6786,0,0.619,0.381,0,1,0,0,0.6333,0.3667,
  0.25,0.25,0.5,0.1111,0.1111,0.7778,0,0.1875,0.8125,0,0.8333,0.1667,0,0.4595,0.5405,0,0.0909,0.9091,0.2611,
  0.3744,0.3645,0.1194,0.4378,0.4428,0,1,0,0,0.7931,0.2069,0,0.3571,0.6429,0,1,0,0.348,0.2804,0.3716,0.1546,
  0.2784,0.567,0.3571,0.199,0.4439,0.4462,0.3333,0.2205,0.4595,0.2703,0.2703,0.233,0.3903,0.3767,0.26,0.48,0.26,
  0.0833,0.5069,0.4097,0.2222,0.1111,0.6667,0,0.5652,0.4348,0.0833,0.0833,0.8333,0.2222,0.5694,0.2083,0.0833,
  0.4167,0.5,0,0.7692,0.2308,0,0.25,0.75,0,0.9375,0.0625,0,0.5,0.5,0,0.8125,0.1875,0,1,0,0,0.0667,0.9333,0,
  0.3864,0.6136,0.55,0.25,0.2,0.1346,0.6731,0.1923,0.8148,0.1111,0.0741,0.4699,0.3388,0.1913,0.4286,0,0.5714,0,
  0,1,0.5091,0.1273,0.3636,0.5165,0.2527,0.2308,0.0667,0,0.9333,0.2118,0.2118,0.5765,0.0833,0.9167,0,0.2941,
  0.1176,0.5882,0.4037,0.4771,0.1193,0.2137,0.458,0.3282,0.1538,0.2692,0.5769,0,0.4,0.6,0,0.8684,0.1316,0,
  0.1739,0.8261,0.1579,0.3684,0.4737,0.4028,0.3472,0.25,0.493,0.1127,0.3944,0.1635,0.3494,0.4872,0.1448,0.4853,
  0.37,0.1702,0.383,0.4468,0.0244,0.6098,0.3659,0,0.3333,0.6667,0,0.6429,0.3571,0,1,0,0,0.375,0.625,0,0.4375,
  0.5625,0,0.7778,0.2222,0.1455,0.3818,0.4727,0.6667,0.1111,0.2222,0.6667,0.1111,0.2222,0,0.5574,0.4426,0.6108,
  0.2432,0.1459,0.3497,0.3005,0.3497,0.3774,0.3341,0.2885,0.1867,0.4133,0.4,0.0476,0.7619,0.1905,0,0.1,0.9,
  0.1921,0.4437,0.3642,0.08,0.24,0.68,0.1667,0.5606,0.2727,0,1,0,0,0.575,0.425,0.0833,0.5,0.4167,0,0.7273,
  0.2727,0,0.2963,0.7037,0,0.875,0.125,0,0.5263,0.4737,0.0833,0.4167,0.5,0.2299,0.3563,0.4138,0.012,0.494,0.494,
  0.0909,0.6591,0.25,0.1007,0.302,0.5973,0,0.7273,0.2727,0.1538,0.1923,0.6538,0,0,1,0,0.6471,0.3529,0.1176,
  0.7353,0.1471,0.451,0.1765,0.3725,0.3333,0.0606,0.6061,0.6027,0.2009,0.1963,0.3182,0.1364,0.5455,0.8571,0,
  0.1429,0.4189,0.3919,0.1892,0.2621,0.3724,0.3655,0.5833,0.2083,0.2083,0,0.6667,0.3333,0,0.2727,0.7273,0.2222,
  0.4444,0.3333,0.0588,0.7647,0.1765,0,0.2308,0.7692,0.1835,0.422,0.3945,0.0667,0.0667,0.8667,0.2963,0.3333,
  0.3704,0.5316,0.4051,0.0633,0.0633,0.3671,0.5696,0.1864,0.5127,0.3008,0.2632,0.4211,0.3158,0,0.5294,0.4706,
  0.0769,0.5769,0.3462,0,0.5844,0.4156,0,0.3824,0.6176,0,0.8,0.2,0,0.7692,0.2308,0.3125,0.375,0.3125,0.6154,
  0.0769,0.3077,0.1889,0.3222,0.4889,0.1268,0.3708,0.5024,0.0341,0.5682,0.3977,0.0971,0.3981,0.5049,0,0.0714,
  0.9286,0.1404,0.2281,0.6316,0.3393,0.3929,0.2679,0.397,0.3185,0.2844,0.1794,0.4103,0.4103,0.1097,0.4129,
  0.4774,0,0.4878,0.5122,0.0156,0.3125,0.6719,0.1622,0.2432,0.5946,0,0.1667,0.8333,0.2771,0.3855,0.3373,0,1,0,0,
  0,1,0,0.5854,0.4146,0,0,1,0.1111,0.2222,0.6667,0.5625,0.25,0.1875,0,0.3846,0.6154,0.2857,0.5714,0.1429,0,
  0.7333,0.2667,0.1,0.5,0.4,0,0.2727,0.7273,0.1233,0.6027,0.274,0,0.7778,0.2222,0,0,1,0,1,0,0,0.75,0.25,
];

/** 模型推理：21维特征 → { hold, buy, sell } 概率（已温度校准） */
export function predictGannAI(x: number[]): { hold: number; buy: number; sell: number } {
  const acc = [0, 0, 0];
  const nTrees = RF_ROOTS.length;
  for (let t = 0; t < nTrees; t++) {
    let n = RF_ROOTS[t];
    while (RF_F[n] !== -1) n = x[RF_F[n]] <= RF_T[n] ? RF_L[n] : RF_R[n];
    const o = RF_T[n] * 3; // 叶节点：T 存叶概率偏移
    acc[0] += RF_P[o]; acc[1] += RF_P[o + 1]; acc[2] += RF_P[o + 2];
  }
  const e = acc.map((v) => Math.pow(Math.max(v / nTrees, 1e-9), 1 / RF_TEMP));
  const s = e[0] + e[1] + e[2] || 1;
  return { hold: e[0] / s, buy: e[1] / s, sell: e[2] / s };
}

