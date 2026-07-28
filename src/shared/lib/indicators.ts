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

export interface CompositeSignal {
  action: '做多' | '做空' | '观望';
  score: number;
  confidence: number;
  summary: string;
  contributors: {
    name: string;
    weight: number;
    rawScore: number;
    weightedScore: number;
    detail: string;
  }[];
}

export function generateCompositeSignal(
  currentPrice: number,
  fibLevels: Record<number, number>,
  structure: MarketStructure | null,
  momentum: MomentumAnalysis | null,
  patterns: PatternSignal[],
  levelTests: Record<number, LevelTest>,
  bollState: BollingerState | null,
): CompositeSignal {
  const contributors: CompositeSignal['contributors'] = [];

  // 1. 市场结构 (权重 30%)
  let structScore = 0;
  let structDetail = '无结构数据';
  if (structure) {
    if (structure.trend === '上升') { structScore = 35; structDetail = '上升趋势'; }
    else if (structure.trend === '下降') { structScore = -35; structDetail = '下降趋势'; }
    else { structScore = 0; structDetail = '盘整结构'; }
    if (structure.lastBreak) {
      if (structure.lastBreak.type === 'BOS') {
        structScore += structure.lastBreak.direction === 'bullish' ? 20 : -20;
        structDetail += `，BOS ${structure.lastBreak.direction === 'bullish' ? '看多' : '看空'}延续`;
      } else if (structure.lastBreak.type === 'CHoCH') {
        structScore = structure.lastBreak.direction === 'bullish' ? 50 : -50;
        structDetail += `，CHoCH ${structure.lastBreak.direction === 'bullish' ? '反转看多' : '反转看空'}`;
      }
    }
  }
  structScore = Math.max(-100, Math.min(100, structScore));
  contributors.push({ name: '市场结构', weight: 0.30, rawScore: structScore, weightedScore: Math.round(structScore * 0.30), detail: structDetail });

  // 2. 势能分析 (权重 25%)
  let momScore = 0;
  let momDetail = '无势能数据';
  if (momentum) { momScore = momentum.momentumScore; momDetail = `RSI ${momentum.rsi} ${momentum.rsiSignal}，${momentum.priceMomentum}，${momentum.overallBias}`; }
  contributors.push({ name: '势能分析', weight: 0.25, rawScore: momScore, weightedScore: Math.round(momScore * 0.25), detail: momDetail });

  // 3. K线形态 (权重 20%)
  let patScore = 0;
  let patDetail = '无显著形态';
  const strongPat = patterns.find((p) => p.confidence >= 60 && p.signal !== '中性');
  if (strongPat) {
    if (strongPat.signal === '做多') { patScore = strongPat.confidence; patDetail = strongPat.desc; }
    else if (strongPat.signal === '做空') { patScore = -strongPat.confidence; patDetail = strongPat.desc; }
  }
  contributors.push({ name: 'K线形态', weight: 0.20, rawScore: patScore, weightedScore: Math.round(patScore * 0.20), detail: patDetail });

  // 4. 关键位测试 (权重 15%)
  let levelScore = 0;
  let levelDetail = '未触及关键位';
  let nearestSolid: { price: number; type: '支撑' | '阻力'; dist: number } | null = null;
  for (const [kStr, price] of Object.entries(fibLevels)) {
    const k = Number(kStr);
    if (!price || price <= 0) continue;
    const test = levelTests[k];
    if (!test || test.verdict !== '结实') continue;
    const type = price < currentPrice ? '支撑' : '阻力';
    const dist = Math.abs(price - currentPrice) / currentPrice * 100;
    if (!nearestSolid || dist < nearestSolid.dist) nearestSolid = { price, type, dist };
  }
  if (nearestSolid) {
    levelScore = nearestSolid.type === '支撑' ? 25 : -25;
    levelDetail = `${nearestSolid.price.toFixed(2)} ${nearestSolid.type === '支撑' ? '支撑位结实，回踩做多' : '阻力位结实，反弹做空'}`;
    if (nearestSolid.dist < 0.5) levelScore *= 1.5;
    else if (nearestSolid.dist > 2) levelScore *= 0.5;
  }
  levelScore = Math.max(-100, Math.min(100, levelScore));
  contributors.push({ name: '关键位测试', weight: 0.15, rawScore: levelScore, weightedScore: Math.round(levelScore * 0.15), detail: levelDetail });

  // 5. 布林带 (权重 10%)
  let bollScore = 0;
  let bollDetail = '无布林带数据';
  if (bollState) {
    if (bollState.squeeze === '极窄（即将突破）') { bollScore = bollState.pricePosition > 50 ? 10 : -10; bollDetail = '收口末端，等待方向'; }
    else if (bollState.pricePosition > 90) { bollScore = -30; bollDetail = '贴近上轨，超买'; }
    else if (bollState.pricePosition < 10) { bollScore = 30; bollDetail = '贴近下轨，超卖'; }
    else if (bollState.midTrend === '上行' && bollState.pricePosition > 50) { bollScore = 15; bollDetail = '开口向上，偏多'; }
    else if (bollState.midTrend === '下行' && bollState.pricePosition < 50) { bollScore = -15; bollDetail = '开口向下，偏空'; }
    else { bollScore = 0; bollDetail = '布林带中性'; }
  }
  contributors.push({ name: '布林带', weight: 0.10, rawScore: bollScore, weightedScore: Math.round(bollScore * 0.10), detail: bollDetail });

  const totalScore = contributors.reduce((s, c) => s + c.weightedScore, 0);
  const signs = contributors.map((c) => Math.sign(c.weightedScore));
  const sameSign = signs.filter((s) => s === Math.sign(totalScore)).length;
  const confidence = Math.round((sameSign / contributors.length) * 100);

  let action: CompositeSignal['action'];
  let summary: string;
  if (totalScore > 35) { action = '做多'; summary = `融合得分 +${totalScore}，${contributors.filter((c) => c.weightedScore > 0).map((c) => c.name).join('+')} 共振看多`; }
  else if (totalScore < -35) { action = '做空'; summary = `融合得分 ${totalScore}，${contributors.filter((c) => c.weightedScore < 0).map((c) => c.name).join('+')} 共振看空`; }
  else { action = '观望'; summary = `融合得分 ${totalScore}，信号混杂或力度不足，建议观望`; }

  return { action, score: totalScore, confidence, summary, contributors };
}

// ========== 综合交易信号（买入/卖出建议）==========

export interface TradeSignal {
  action: '做多' | '做空' | '观望';
  /** 建议入场价格 */
  entryPrice: number;
  /** 止损价格 */
  stopLoss: number;
  /** 止盈价格（第一目标位） */
  takeProfit: number;
  /** 盈亏比 */
  riskReward: string;
  /** 关键依据 */
  reason: string;
  /** 确定性 0~100 */
  confidence: number;
}

export function generateTradeSignal(
  currentPrice: number,
  fibLevels: Record<number, number>,
  momentum: MomentumAnalysis,
  levelTests: Record<number, LevelTest>,
  patterns: PatternSignal[],
  bollState: BollingerState | null,
): TradeSignal {
  const defaultSignal: TradeSignal = {
    action: '观望',
    entryPrice: currentPrice,
    stopLoss: currentPrice * 0.98,
    takeProfit: currentPrice * 1.02,
    riskReward: '1:1',
    reason: '信号不明确，建议观望',
    confidence: 0,
  };

  // 1. 布林带极窄时 —— 方向不明，不建议入场
  if (bollState && bollState.squeeze === '极窄（即将突破）') {
    return {
      ...defaultSignal,
      reason: '布林带极窄，波动率收缩，等待突破方向明确后再入场',
      confidence: 30,
    };
  }

  // 2. K线形态强信号优先
  const strongPattern = patterns.find((p) => p.confidence >= 70 && p.signal !== '中性');
  if (strongPattern && strongPattern.nearLevel !== null) {
    const levelPrice = fibLevels[strongPattern.nearLevel] || currentPrice;
    if (strongPattern.signal === '做多') {
      const sl = levelPrice * 0.985;
      const tpResist = findNearestResistance_(currentPrice, fibLevels, levelTests);
      const tp = tpResist ? tpResist.price : levelPrice * 1.03;
      const rr = ((tp - levelPrice) / (levelPrice - sl)).toFixed(1);
      return {
        action: '做多',
        entryPrice: levelPrice,
        stopLoss: sl,
        takeProfit: tp,
        riskReward: `1:${rr}`,
        reason: `${strongPattern.name} + ${strongPattern.nearLevelLabel} ${strongPattern.levelType}位，${strongPattern.desc}`,
        confidence: strongPattern.confidence,
      };
    }
    if (strongPattern.signal === '做空') {
      const sl = levelPrice * 1.015;
      const tpSup = findNearestSupport_(currentPrice, fibLevels, levelTests);
      const tp = tpSup ? tpSup.price : levelPrice * 0.97;
      const rr = ((levelPrice - tp) / (sl - levelPrice)).toFixed(1);
      return {
        action: '做空',
        entryPrice: levelPrice,
        stopLoss: sl,
        takeProfit: tp,
        riskReward: `1:${rr}`,
        reason: `${strongPattern.name} + ${strongPattern.nearLevelLabel} ${strongPattern.levelType}位，${strongPattern.desc}`,
        confidence: strongPattern.confidence,
      };
    }
  }

  // 3. 势能偏多 → 找结实支撑位做多
  if (momentum.momentumScore > 15) {
    const support = findNearestSupport_(currentPrice, fibLevels, levelTests);
    if (support && support.price < currentPrice) {
      const sl = support.price * 0.985;
      const tpResist = findNearestResistance_(currentPrice, fibLevels, levelTests);
      const tp = tpResist ? tpResist.price : support.price * 1.03;
      const rr = ((tp - support.price) / (support.price - sl)).toFixed(1);
      return {
        action: '做多',
        entryPrice: support.price,
        stopLoss: sl,
        takeProfit: tp,
        riskReward: `1:${rr}`,
        reason: `势能偏多（评分${momentum.momentumScore}），${support.label} 支撑位结实（强度${support.strength}），回踩买入`,
        confidence: Math.min(85, 50 + momentum.momentumScore + support.strength / 3),
      };
    }
  }

  // 4. 势能偏空 → 找结实阻力位做空
  if (momentum.momentumScore < -15) {
    const resist = findNearestResistance_(currentPrice, fibLevels, levelTests);
    if (resist && resist.price > currentPrice) {
      const sl = resist.price * 1.015;
      const tpSup = findNearestSupport_(currentPrice, fibLevels, levelTests);
      const tp = tpSup ? tpSup.price : resist.price * 0.97;
      const rr = ((resist.price - tp) / (sl - resist.price)).toFixed(1);
      return {
        action: '做空',
        entryPrice: resist.price,
        stopLoss: sl,
        takeProfit: tp,
        riskReward: `1:${rr}`,
        reason: `势能偏空（评分${momentum.momentumScore}），${resist.label} 阻力位结实（强度${resist.strength}），反弹做空`,
        confidence: Math.min(85, 50 + Math.abs(momentum.momentumScore) + resist.strength / 3),
      };
    }
  }

  // 5. 多空均衡但有结实位
  const nearestSolid = findNearestSolidLevel_(currentPrice, fibLevels, levelTests);
  if (nearestSolid) {
    if (nearestSolid.type === '支撑' && nearestSolid.price < currentPrice) {
      const sl = nearestSolid.price * 0.985;
      const tp = nearestSolid.price * 1.025;
      return {
        action: '做多',
        entryPrice: nearestSolid.price,
        stopLoss: sl,
        takeProfit: tp,
        riskReward: '1:1.7',
        reason: `多空均衡，${nearestSolid.label} 支撑位结实，轻仓试多`,
        confidence: 45,
      };
    }
    if (nearestSolid.type === '阻力' && nearestSolid.price > currentPrice) {
      const sl = nearestSolid.price * 1.015;
      const tp = nearestSolid.price * 0.975;
      return {
        action: '做空',
        entryPrice: nearestSolid.price,
        stopLoss: sl,
        takeProfit: tp,
        riskReward: '1:1.7',
        reason: `多空均衡，${nearestSolid.label} 阻力位结实，轻仓试空`,
        confidence: 45,
      };
    }
  }

  return defaultSignal;
}

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

export interface TradePlan {
  /** 第一步：方向 */
  structure: '上升' | '下降' | '盘整';
  structureDetail: string;
  /** 第二步：等待位 */
  waitPrice: number | null;
  waitLabel: string;
  waitType: '回踩支撑' | '反弹阻力' | '等待突破' | 'FVG缺口' | '无';
  /** 第三步：触发条件 */
  triggerCondition: string;
  /** 第四步：止损 */
  stopLoss: number | null;
  stopLossLabel: string;
  /** 第五步：目标 */
  target1: number | null;
  target1Label: string;
  target2: number | null;
  target2Label: string;
  /** 当前状态：等待/已到位/已触发 */
  status: '等待' | '已到位' | '已触发';
  /** 当前价距离等待位的距离百分比 */
  distToWait: number | null;
  /** 做多还是做空 */
  direction: '做多' | '做空' | '观望';
  /** 计划是否有效 */
  valid: boolean;
  /** 多周期趋势过滤 */
  multiTF: MultiTimeframeBias | null;
  /** 盈亏比 */
  riskReward: number | null;
  /** ATR 值 */
  atr: number | null;
  /** FVG 入场位 */
  fvgEntry: number | null;
  fvgLabel: string;
}

export function buildTradePlan(
  currentPrice: number,
  mkStructure: MarketStructure | null,
  fibLevels: Record<number, number>,
  momentum: MomentumAnalysis | null,
  patterns: PatternSignal[],
  klines: KlineData[],
  higherTFStructure: MarketStructure | null,
  fvgs: FVG[],
  orderBlocks: OrderBlock[] = [],
  sweeps: LiquiditySweep[] = [],
): TradePlan {
  const labels: Record<number, string> = { 0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5', 618: '0.618', 786: '0.786', 100: '1.0', 1272: 'E1.272', 1618: 'E1.618' };

  const defaultPlan: TradePlan = {
    structure: '盘整', structureDetail: '无结构数据',
    waitPrice: null, waitLabel: '—', waitType: '无',
    triggerCondition: '需要更多数据',
    stopLoss: null, stopLossLabel: '—',
    target1: null, target1Label: '—',
    target2: null, target2Label: '—',
    status: '等待', distToWait: null,
    direction: '观望', valid: false,
    multiTF: null, riskReward: null, atr: null,
    fvgEntry: null, fvgLabel: '',
  };

  if (!mkStructure || mkStructure.swings.length < 4) return defaultPlan;

  const st = mkStructure;
  const dir = st.trend;

  // 计算多周期趋势过滤
  const multiTF = analyzeMultiTimeframeBias(higherTFStructure, mkStructure);

  // 构建结构详情
  const recentSeq = st.structureSeq.slice(-4).join(' → ') || '形成中';
  let structDetail = `${dir}结构（${recentSeq}）`;
  if (st.lastBreak) {
    structDetail += `，${st.lastBreak.type} ${st.lastBreak.direction === 'bullish' ? '看多' : '看空'}突破`;
  }

  // 计算 ATR
  const atr = calcATR(klines, 14);

  // 寻找方向匹配的 FVG 作为潜在入场位
  const matchedFVG = fvgs.find((f) => {
    if (dir === '上升') return f.type === 'bullish' && f.end < currentPrice;
    if (dir === '下降') return f.type === 'bearish' && f.start > currentPrice;
    return false;
  });

  // 辅助：计算盈亏比
  function calcRR(entry: number, sl: number, tp: number, direction: '做多' | '做空'): number {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    return risk > 0 ? Math.round((reward / risk) * 10) / 10 : 0;
  }

  // ====== 上升趋势：等回踩前低或 FVG ======
  if (dir === '上升' && st.lastSwingLow && st.lastSwingHigh) {
    // 优先使用 FVG 作为入场位，否则用前低
    const useFVG = matchedFVG && matchedFVG.end < st.lastSwingLow.price * 1.005;
    const entry = useFVG ? matchedFVG.end : st.lastSwingLow.price;
    const entryLabel = useFVG
      ? `FVG缺口 $${entry.toFixed(2)}`
      : `前低 $${entry.toFixed(2)}`;

    const sl = calcATRStopLoss(entry, klines, '做多', 1.5);
    const dist = ((currentPrice - entry) / currentPrice) * 100;
    const arrived = currentPrice <= entry * 1.003;

    // 目标：前高
    const t1 = st.lastSwingHigh.price;
    let t2: number | null = null;
    let t2Label = '';
    const fibAbove = Object.entries(fibLevels)
      .map(([k, p]) => ({ key: Number(k), price: p, label: labels[Number(k)] || k }))
      .filter((f) => f.price > t1 && f.price > currentPrice)
      .sort((a, b) => a.price - b.price);
    if (fibAbove.length > 0) { t2 = fibAbove[0].price; t2Label = fibAbove[0].label; }

    // 盈亏比检查
    const rr = calcRR(entry, sl, t1, '做多');

    // 检查 OB 和 Sweep 信号
    const inBullOB = orderBlocks.find((ob) =>
      ob.type === 'bullish' && currentPrice >= ob.bottom * 0.998 && currentPrice <= ob.top * 1.002
    );
    const recentSellSweep = sweeps.find((s) =>
      s.type === 'sellSide' && s.isValid && s.sweepIndex >= klines.length - 5
    );

    // 触发条件
    const strongPat = patterns.find((p) => p.confidence >= 60 && p.signal === '做多');
    let trigger: string;
    if (inBullOB) {
      trigger = `进入看涨订单块 $${inBullOB.bottom.toFixed(2)}-$${inBullOB.top.toFixed(2)}，可入场`;
    } else if (recentSellSweep) {
      trigger = `前低流动性已猎杀，假跌破后收回，可入场`;
    } else if (strongPat) {
      trigger = `${strongPat.name}已出现，可入场`;
    } else if (momentum && momentum.rsi <= 35) {
      trigger = `RSI ${momentum.rsi} 超卖区，可入场`;
    } else if (momentum && momentum.volumeTrend === '缩量') {
      trigger = '缩量回踩，观察是否企稳';
    } else {
      trigger = '等待反转 K 线、RSI 超卖或 OB/Sweep 信号';
    }

    const triggered = arrived && (
      inBullOB || recentSellSweep || strongPat || (momentum && momentum.rsi <= 35)
    );

    // 多周期过滤：如果大周期不支持，降低 valid 或改为观望
    let planDirection: '做多' | '做空' | '观望' = '做多';
    let planValid = true;
    if (multiTF.tradingDirection === '观望') {
      planDirection = '观望';
      planValid = false;
      trigger = `【过滤】${multiTF.summary}；原触发：${trigger}`;
    } else if (multiTF.tradingDirection === '做空') {
      planDirection = '观望';
      planValid = false;
      trigger = `【过滤】大周期与当前方向冲突；原触发：${trigger}`;
    }
    // 盈亏比过滤
    if (rr > 0 && rr < 2) {
      planValid = false;
      trigger = `【过滤】盈亏比 ${rr}:1 < 2:1，不满足最低要求；原触发：${trigger}`;
    }

    return {
      structure: dir,
      structureDetail: structDetail,
      waitPrice: entry,
      waitLabel: entryLabel,
      waitType: useFVG ? 'FVG缺口' : '回踩支撑',
      triggerCondition: trigger,
      stopLoss: sl,
      stopLossLabel: `ATR止损 $${sl.toFixed(2)}（1.5×ATR）`,
      target1: t1,
      target1Label: `前高 $${t1.toFixed(2)}`,
      target2: t2,
      target2Label: t2 ? `${t2Label} $${t2.toFixed(2)}` : '—',
      status: triggered && planValid ? '已触发' : arrived ? '已到位' : '等待',
      distToWait: Math.round(dist * 100) / 100,
      direction: planDirection,
      valid: planValid,
      multiTF,
      riskReward: rr,
      atr: Math.round(atr * 100) / 100,
      fvgEntry: matchedFVG ? matchedFVG.end : null,
      fvgLabel: matchedFVG ? `FVG $${matchedFVG.end.toFixed(2)}` : '',
    };
  }

  // ====== 下降趋势：等反弹前高或 FVG ======
  if (dir === '下降' && st.lastSwingHigh && st.lastSwingLow) {
    const useFVG = matchedFVG && matchedFVG.start > st.lastSwingHigh.price * 0.995;
    const entry = useFVG ? matchedFVG.start : st.lastSwingHigh.price;
    const entryLabel = useFVG
      ? `FVG缺口 $${entry.toFixed(2)}`
      : `前高 $${entry.toFixed(2)}`;

    const sl = calcATRStopLoss(entry, klines, '做空', 1.5);
    const dist = ((entry - currentPrice) / currentPrice) * 100;
    const arrived = currentPrice >= entry * 0.997;

    const t1 = st.lastSwingLow.price;
    let t2: number | null = null;
    let t2Label = '';
    const fibBelow = Object.entries(fibLevels)
      .map(([k, p]) => ({ key: Number(k), price: p, label: labels[Number(k)] || k }))
      .filter((f) => f.price < t1 && f.price < currentPrice)
      .sort((a, b) => b.price - a.price);
    if (fibBelow.length > 0) { t2 = fibBelow[0].price; t2Label = fibBelow[0].label; }

    const rr = calcRR(entry, sl, t1, '做空');

    // 检查 OB 和 Sweep 信号
    const inBearOB = orderBlocks.find((ob) =>
      ob.type === 'bearish' && currentPrice >= ob.bottom * 0.998 && currentPrice <= ob.top * 1.002
    );
    const recentBuySweep = sweeps.find((s) =>
      s.type === 'buySide' && s.isValid && s.sweepIndex >= klines.length - 5
    );

    const strongPat = patterns.find((p) => p.confidence >= 60 && p.signal === '做空');
    let trigger: string;
    if (inBearOB) {
      trigger = `进入看跌订单块 $${inBearOB.bottom.toFixed(2)}-$${inBearOB.top.toFixed(2)}，可入场`;
    } else if (recentBuySweep) {
      trigger = `前高流动性已猎杀，假突破后收回，可入场`;
    } else if (strongPat) {
      trigger = `${strongPat.name}已出现，可入场`;
    } else if (momentum && momentum.rsi >= 65) {
      trigger = `RSI ${momentum.rsi} 超买区，可入场`;
    } else {
      trigger = '等待反转 K 线、RSI 超买或 OB/Sweep 信号';
    }

    const triggered = arrived && (
      inBearOB || recentBuySweep || strongPat || (momentum && momentum.rsi >= 65)
    );

    let planDirection: '做多' | '做空' | '观望' = '做空';
    let planValid = true;
    if (multiTF.tradingDirection === '观望') {
      planDirection = '观望';
      planValid = false;
      trigger = `【过滤】${multiTF.summary}；原触发：${trigger}`;
    } else if (multiTF.tradingDirection === '做多') {
      planDirection = '观望';
      planValid = false;
      trigger = `【过滤】大周期与当前方向冲突；原触发：${trigger}`;
    }
    if (rr > 0 && rr < 2) {
      planValid = false;
      trigger = `【过滤】盈亏比 ${rr}:1 < 2:1，不满足最低要求；原触发：${trigger}`;
    }

    return {
      structure: dir,
      structureDetail: structDetail,
      waitPrice: entry,
      waitLabel: entryLabel,
      waitType: useFVG ? 'FVG缺口' : '反弹阻力',
      triggerCondition: trigger,
      stopLoss: sl,
      stopLossLabel: `ATR止损 $${sl.toFixed(2)}（1.5×ATR）`,
      target1: t1,
      target1Label: `前低 $${t1.toFixed(2)}`,
      target2: t2,
      target2Label: t2 ? `${t2Label} $${t2.toFixed(2)}` : '—',
      status: triggered && planValid ? '已触发' : arrived ? '已到位' : '等待',
      distToWait: Math.round(dist * 100) / 100,
      direction: planDirection,
      valid: planValid,
      multiTF,
      riskReward: rr,
      atr: Math.round(atr * 100) / 100,
      fvgEntry: matchedFVG ? matchedFVG.start : null,
      fvgLabel: matchedFVG ? `FVG $${matchedFVG.start.toFixed(2)}` : '',
    };
  }

  // ====== 盘整：等突破 ======
  if (st.lastSwingHigh && st.lastSwingLow) {
    const range = st.lastSwingHigh.price - st.lastSwingLow.price;
    const midPoint = (st.lastSwingHigh.price + st.lastSwingLow.price) / 2;

    const biasUp = currentPrice > midPoint;
    const breakLevel = biasUp ? st.lastSwingHigh.price : st.lastSwingLow.price;
    const breakDir = biasUp ? '做多' : '做空';
    const dist = ((breakLevel - currentPrice) / currentPrice) * 100 * (biasUp ? 1 : -1);

    const sl = biasUp
      ? calcATRStopLoss(breakLevel, klines, '做多', 1.5)
      : calcATRStopLoss(breakLevel, klines, '做空', 1.5);
    const tp = biasUp ? breakLevel + range : breakLevel - range;
    const rr = calcRR(breakLevel, sl, tp, breakDir as '做多' | '做空');

    let trigger = `放量突破 ${biasUp ? '区间顶部' : '区间底部'} + 回踩确认`;
    let planValid = true;
    if (multiTF.tradingDirection === '观望' || multiTF.tradingDirection !== breakDir) {
      planValid = false;
      trigger = `【过滤】${multiTF.summary}；原触发：${trigger}`;
    }
    if (rr > 0 && rr < 2) {
      planValid = false;
      trigger = `【过滤】盈亏比 ${rr}:1 < 2:1；原触发：${trigger}`;
    }

    return {
      structure: '盘整',
      structureDetail: structDetail,
      waitPrice: breakLevel,
      waitLabel: biasUp ? `区间顶部 $${breakLevel.toFixed(2)}` : `区间底部 $${breakLevel.toFixed(2)}`,
      waitType: '等待突破',
      triggerCondition: trigger,
      stopLoss: sl,
      stopLossLabel: biasUp ? `区间底部 $${st.lastSwingLow.price.toFixed(2)}` : `区间顶部 $${st.lastSwingHigh.price.toFixed(2)}`,
      target1: tp,
      target1Label: `等幅目标 $${tp.toFixed(2)}`,
      target2: null, target2Label: '—',
      status: '等待',
      distToWait: Math.round(Math.abs(dist) * 100) / 100,
      direction: multiTF.tradingDirection === breakDir ? breakDir as '做多' | '做空' : '观望',
      valid: planValid,
      multiTF,
      riskReward: rr,
      atr: Math.round(atr * 100) / 100,
      fvgEntry: null,
      fvgLabel: '',
    };
  }

  return defaultPlan;
}


// ========== 市场结构识别（SMC 风格）==========

export type SwingType = 'swingHigh' | 'swingLow';
export type StructureType = 'HH' | 'HL' | 'LH' | 'LL';
export type BreakType = 'BOS' | 'CHoCH' | null;

export interface SwingPoint {
  type: SwingType;
  index: number;
  price: number;
  time: number;
}

export interface StructureBreak {
  type: BreakType;
  /** 突破的是哪个 swing point */
  brokenSwing: SwingPoint;
  /** 突破发生的那根 K 线 index */
  breakIndex: number;
  breakPrice: number;
  direction: 'bullish' | 'bearish';
}

export interface MarketStructure {
  /** 最近识别的所有 swing points */
  swings: SwingPoint[];
  /** 结构序列 */
  structureSeq: StructureType[];
  /** 最近的突破事件 */
  lastBreak: StructureBreak | null;
  /** 当前趋势：上升/下降/盘整 */
  trend: '上升' | '下降' | '盘整';
  /** 最近一个 swing high（可能作为阻力） */
  lastSwingHigh: SwingPoint | null;
  /** 最近一个 swing low（可能作为支撑） */
  lastSwingLow: SwingPoint | null;
  /** 等待突破的关键位（上升等突破前高，下降等突破前低） */
  keyLevel: number | null;
  /** 一句话总结 */
  summary: string;
}

export function analyzeMarketStructure(klines: KlineData[], strength: number = 3): MarketStructure {
  const result: MarketStructure = {
    swings: [],
    structureSeq: [],
    lastBreak: null,
    trend: '盘整',
    lastSwingHigh: null,
    lastSwingLow: null,
    keyLevel: null,
    summary: '',
  };

  if (klines.length < strength * 2 + 5) return result;

  // 1. 识别 swing points
  const swings: SwingPoint[] = [];
  for (let i = strength; i < klines.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ type: 'swingHigh', index: i, price: klines[i].high, time: klines[i].time });
    if (isLow) swings.push({ type: 'swingLow', index: i, price: klines[i].low, time: klines[i].time });
  }
  // 按时间排序
  swings.sort((a, b) => a.index - b.index);
  result.swings = swings;

  if (swings.length < 4) {
    result.summary = 'Swing 点不足，无法判断结构';
    return result;
  }

  // 2. 识别结构序列 HH/HL/LH/LL
  const seq: StructureType[] = [];
  for (let i = 2; i < swings.length; i++) {
    const prev2 = swings[i - 2];
    const prev1 = swings[i - 1];
    const curr = swings[i];

    // 同类型比较（高比高，低比低）
    if (curr.type === 'swingHigh' && prev2.type === 'swingHigh') {
      if (curr.price > prev2.price) seq.push('HH');
      else if (curr.price < prev2.price) seq.push('LH');
    }
    if (curr.type === 'swingLow' && prev2.type === 'swingLow') {
      if (curr.price > prev2.price) seq.push('HL');
      else if (curr.price < prev2.price) seq.push('LL');
    }
  }
  result.structureSeq = seq;

  // 3. 识别 BOS 和 CHoCH
  let lastBreak: StructureBreak | null = null;
  for (let i = 0; i < swings.length - 1; i++) {
    const sw = swings[i];
    const nextSw = swings[i + 1];

    if (sw.type === 'swingLow') {
      // 检查后续 K 线是否突破了最近的 swing high
      const recentHighs = swings.slice(0, i).filter((s) => s.type === 'swingHigh');
      if (recentHighs.length === 0) continue;
      const lastHigh = recentHighs[recentHighs.length - 1];
      for (let k = sw.index + 1; k < (nextSw ? nextSw.index : klines.length); k++) {
        if (klines[k].close > lastHigh.price) {
          // 判断是 BOS 还是 CHoCH
          const prevStructures = seq.slice(0, Math.max(0, seq.length - 2));
          const wasBearish = prevStructures.filter((s) => s === 'LH' || s === 'LL').length > prevStructures.filter((s) => s === 'HH' || s === 'HL').length;
          lastBreak = {
            type: wasBearish ? 'CHoCH' : 'BOS',
            brokenSwing: lastHigh,
            breakIndex: k,
            breakPrice: klines[k].close,
            direction: 'bullish',
          };
          break;
        }
      }
    }

    if (sw.type === 'swingHigh') {
      // 检查后续 K 线是否突破了最近的 swing low
      const recentLows = swings.slice(0, i).filter((s) => s.type === 'swingLow');
      if (recentLows.length === 0) continue;
      const lastLow = recentLows[recentLows.length - 1];
      for (let k = sw.index + 1; k < (nextSw ? nextSw.index : klines.length); k++) {
        if (klines[k].close < lastLow.price) {
          const prevStructures = seq.slice(0, Math.max(0, seq.length - 2));
          const wasBullish = prevStructures.filter((s) => s === 'HH' || s === 'HL').length > prevStructures.filter((s) => s === 'LH' || s === 'LL').length;
          lastBreak = {
            type: wasBullish ? 'CHoCH' : 'BOS',
            brokenSwing: lastLow,
            breakIndex: k,
            breakPrice: klines[k].close,
            direction: 'bearish',
          };
          break;
        }
      }
    }
  }
  result.lastBreak = lastBreak;

  // 4. 判断趋势
  const recent = seq.slice(-4);
  const bullCount = recent.filter((s) => s === 'HH' || s === 'HL').length;
  const bearCount = recent.filter((s) => s === 'LH' || s === 'LL').length;
  if (bullCount >= 3) result.trend = '上升';
  else if (bearCount >= 3) result.trend = '下降';
  else if (lastBreak) {
    result.trend = lastBreak.direction === 'bullish' ? '上升' : '下降';
  }
  else result.trend = '盘整';

  // 5. 最近的 swing high / low
  const highs = swings.filter((s) => s.type === 'swingHigh');
  const lows = swings.filter((s) => s.type === 'swingLow');
  result.lastSwingHigh = highs.length > 0 ? highs[highs.length - 1] : null;
  result.lastSwingLow = lows.length > 0 ? lows[lows.length - 1] : null;

  // 6. 等待突破的关键位
  if (result.trend === '上升' && result.lastSwingHigh) {
    result.keyLevel = result.lastSwingHigh.price;
  } else if (result.trend === '下降' && result.lastSwingLow) {
    result.keyLevel = result.lastSwingLow.price;
  } else if (result.lastSwingHigh && result.lastSwingLow) {
    // 盘整时看当前价离哪个近
    const lastClose = klines[klines.length - 1].close;
    const distHigh = Math.abs(lastClose - result.lastSwingHigh.price);
    const distLow = Math.abs(lastClose - result.lastSwingLow.price);
    result.keyLevel = distHigh < distLow ? result.lastSwingHigh.price : result.lastSwingLow.price;
  }

  // 7. 总结
  const lastSeq = seq.slice(-3);
  const seqStr = lastSeq.join(' → ');
  if (result.lastBreak) {
    result.summary = `${result.lastBreak.type}（${result.lastBreak.direction === 'bullish' ? '看多' : '看空'}），${result.trend}结构，等待 ${result.keyLevel ? `$${result.keyLevel.toFixed(2)}` : '—'}`;
  } else {
    result.summary = `${result.trend}结构（${seqStr || '形成中'}），关注 ${result.keyLevel ? `$${result.keyLevel.toFixed(2)}` : '—'} 突破`;
  }

  return result;
}


// ========== K 线形态识别 =================

/** K线形态类型 */
export type CandlePattern =
  | 'hammer'              // 锤子线
  | 'shootingStar'        // 射击之星
  | 'doji'                // 十字星
  | 'spinningTop'         // 纺锤线
  | 'bullishMarubozu'     // 大阳线
  | 'bearishMarubozu'     // 大阴线
  | 'bullishEngulfing'    // 看涨吞没
  | 'bearishEngulfing'    // 看跌吞没
  | 'bullishHarami'       // 看涨孕线
  | 'bearishHarami'       // 看跌孕线
  | 'darkCloudCover'      // 乌云盖顶
  | 'piercingLine'        // 刺透形态
  | 'morningStar'         // 启明星
  | 'eveningStar'         // 黄昏星
  | 'threeWhiteSoldiers'  // 三白兵
  | 'threeBlackCrows'     // 三只乌鸦
  | 'none';               // 无形态

/** 形态信号 */
export interface PatternSignal {
  /** 形态类型标识 */
  pattern: CandlePattern;
  /** 形态中文名称 */
  name: string;
  /** 出现在哪个斐波那契位附近（null=未在任何关键位附近） */
  nearLevel: number | null;
  nearLevelLabel: string;
  /** 在该位的方向：支撑/阻力 */
  levelType: '支撑' | '阻力' | null;
  /** 综合信号：做多/做空/中性 */
  signal: '做多' | '做空' | '中性';
  /** 确定性 0~100 */
  confidence: number;
  /** 一句话描述 */
  desc: string;
  /** 形态类别：单根/双根/三根 */
  category: '单根' | '双根' | '三根';
}

/** 提取K线基本属性 */
function candleProps(k: KlineData) {
  const body = Math.abs(k.close - k.open);
  const totalRange = k.high - k.low;
  const isBull = k.close > k.open;
  const upperWick = k.high - Math.max(k.close, k.open);
  const lowerWick = Math.min(k.close, k.open) - k.low;
  const bodyTop = Math.max(k.close, k.open);
  const bodyBottom = Math.min(k.close, k.open);
  const bodyRatio = totalRange > 0 ? body / totalRange : 0;
  return { body, totalRange, isBull, upperWick, lowerWick, bodyTop, bodyBottom, bodyRatio };
}

/**
 * 完整K线形态识别系统
 * 识别单根、双根、三根K线形态，结合斐波那契关键位判断信号强度
 */
export function detectCandlePatterns(
  klines: KlineData[],
  fibLevels: Record<number, number>,
  tolerancePct: number = 0.2,
): PatternSignal[] {
  if (klines.length < 5) return [];
  const len = klines.length;
  const results: PatternSignal[] = [];

  // 取最近几根K线
  const last = klines[len - 1];
  const prev = klines[len - 2];
  const prev2 = len >= 3 ? klines[len - 3] : null;
  const lp = candleProps(last);
  const pp = candleProps(prev);
  const p2p = prev2 ? candleProps(prev2) : null;

  // ===== 判断是否在某关键位附近 =====
  function findNearLevel(price: number): { key: number; label: string; type: '支撑' | '阻力' } | null {
    for (const [kStr, lv] of Object.entries(fibLevels)) {
      const k = Number(kStr);
      if (!lv || lv <= 0) continue;
      const tol = lv * (tolerancePct / 100);
      if (price >= lv - tol && price <= lv + tol) {
        const type = price > lv ? '支撑' : '阻力';
        const labels: Record<number, string> = {
          0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5',
          618: '0.618', 786: '0.786', 100: '1.0', 1272: 'E1.272', 1618: 'E1.618',
        };
        return { key: k, label: labels[k] || `${k}`, type };
      }
    }
    return null;
  }

  const near = findNearLevel(last.close);
  const nearKey = near?.key ?? null;
  const nearLabel = near?.label ?? '';
  const nearType = near?.type ?? null;

  // 辅助：生成形态信号（根据是否在关键位动态调整置信度和方向）
  function makeSignal(
    pattern: CandlePattern,
    name: string,
    category: '单根' | '双根' | '三根',
    baseBias: '做多' | '做空' | '中性',
    baseConf: number,
    descAtLevel: string,
    descNoLevel: string,
  ): PatternSignal {
    const atLevel = nearType === '支撑' && baseBias === '做多'
      || nearType === '阻力' && baseBias === '做空';
    const conf = atLevel ? Math.min(baseConf + 25, 95) : nearType ? baseConf + 10 : baseConf;
    return {
      pattern, name, category,
      nearLevel: nearKey, nearLevelLabel: nearLabel, levelType: nearType,
      signal: atLevel ? baseBias : nearType ? baseBias : '中性',
      confidence: conf,
      desc: atLevel ? descAtLevel : nearType ? `${nearLabel} ${nearType}位${descNoLevel}` : descNoLevel,
    };
  }

  // ========================================
  // 一、单根K线形态
  // ========================================

  // 1. 锤子线（Hammer）：下影线>=实体2倍，上影线<实体0.5倍，实体在整根K线上部
  if (lp.totalRange > 0
    && lp.lowerWick >= lp.body * 2
    && lp.upperWick < lp.body * 0.5
    && lp.bodyBottom > last.low + lp.totalRange * 0.3) {
    results.push(makeSignal(
      'hammer', '锤子线', '单根', '做多', 55,
      `${nearLabel} 支撑位出现锤子线，下方买盘强，看多反转`,
      '锤子线出现，下影线较长显示买盘承接，需关键位确认',
    ));
  }

  // 2. 射击之星（Shooting Star）：上影线>=实体2倍，下影线<实体0.5倍，实体在整根K线下部
  if (lp.totalRange > 0
    && lp.upperWick >= lp.body * 2
    && lp.lowerWick < lp.body * 0.5
    && lp.bodyTop < last.high - lp.totalRange * 0.3) {
    results.push(makeSignal(
      'shootingStar', '射击之星', '单根', '做空', 55,
      `${nearLabel} 阻力位出现射击之星，上方抛压强，看空反转`,
      '射击之星出现，上影线较长显示卖盘打压，需关键位确认',
    ));
  }

  // 3. 十字星（Doji）：实体<整根K线范围的10%
  if (lp.totalRange > 0 && lp.bodyRatio < 0.1) {
    results.push(makeSignal(
      'doji', '十字星', '单根', '中性', 35,
      `${nearLabel} ${nearType}位出现十字星，多空犹豫，即将选方向`,
      '十字星出现，市场犹豫不决，需结合其他信号判断方向',
    ));
  }

  // 4. 纺锤线（Spinning Top）：实体小（<30%），上下影线都较长（>实体0.5倍）
  if (lp.totalRange > 0
    && lp.bodyRatio < 0.3
    && lp.bodyRatio >= 0.1
    && lp.upperWick > lp.body * 0.5
    && lp.lowerWick > lp.body * 0.5) {
    results.push(makeSignal(
      'spinningTop', '纺锤线', '单根', '中性', 25,
      `${nearLabel} ${nearType}位出现纺锤线，多空拉锯激烈`,
      '纺锤线出现，上下影线均较长，多空力量接近均衡',
    ));
  }

  // 5. 大阳线（Bullish Marubozu）：实体占整根K线90%以上
  if (lp.isBull && lp.totalRange > 0 && lp.bodyRatio >= 0.9) {
    results.push(makeSignal(
      'bullishMarubozu', '大阳线', '单根', '做多', 60,
      `${nearLabel} 支撑位出现大阳线，多头强势拉升`,
      '大阳线出现，多头完全控制局面，几乎无上影线',
    ));
  }

  // 6. 大阴线（Bearish Marubozu）：实体占整根K线90%以上
  if (!lp.isBull && lp.totalRange > 0 && lp.bodyRatio >= 0.9) {
    results.push(makeSignal(
      'bearishMarubozu', '大阴线', '单根', '做空', 60,
      `${nearLabel} 阻力位出现大阴线，空头强势打压`,
      '大阴线出现，空头完全控制局面，几乎无下影线',
    ));
  }

  // ========================================
  // 二、双根K线组合
  // ========================================

  // 7. 看涨吞没（Bullish Engulfing）：前阴后阳，阳线实体完全包住阴线实体
  if (!pp.isBull && lp.isBull
    && last.close > prev.open
    && last.open < prev.close
    && lp.body > pp.body * 1.2) {
    results.push(makeSignal(
      'bullishEngulfing', '看涨吞没', '双根', '做多', 60,
      `${nearLabel} 支撑位出现看涨吞没，强反转信号`,
      '看涨吞没形态出现，阳线完全包住前阴，短期偏多',
    ));
  }

  // 8. 看跌吞没（Bearish Engulfing）：前阳后阴，阴线实体完全包住阳线实体
  if (pp.isBull && !lp.isBull
    && last.open > prev.close
    && last.close < prev.open
    && lp.body > pp.body * 1.2) {
    results.push(makeSignal(
      'bearishEngulfing', '看跌吞没', '双根', '做空', 60,
      `${nearLabel} 阻力位出现看跌吞没，强反转信号`,
      '看跌吞没形态出现，阴线完全包住前阳，短期偏空',
    ));
  }

  // 9. 看涨孕线（Bullish Harami）：前大阴后小阳，小阳实体在前阴实体内部
  if (!pp.isBull && lp.isBull
    && pp.bodyRatio > 0.4
    && lp.body < pp.body * 0.6
    && last.open > prev.close
    && last.close < prev.open) {
    results.push(makeSignal(
      'bullishHarami', '看涨孕线', '双根', '做多', 50,
      `${nearLabel} 支撑位出现看涨孕线，跌势可能放缓`,
      '看涨孕线形态出现，小阳实体被前阴包裹，下跌动能减弱',
    ));
  }

  // 10. 看跌孕线（Bearish Harami）：前大阳后小阴，小阴实体在前阳实体内部
  if (pp.isBull && !lp.isBull
    && pp.bodyRatio > 0.4
    && lp.body < pp.body * 0.6
    && last.open < prev.close
    && last.close > prev.open) {
    results.push(makeSignal(
      'bearishHarami', '看跌孕线', '双根', '做空', 50,
      `${nearLabel} 阻力位出现看跌孕线，涨势可能放缓`,
      '看跌孕线形态出现，小阴实体被前阳包裹，上涨动能减弱',
    ));
  }

  // 11. 乌云盖顶（Dark Cloud Cover）：前阳后阴，阴线开盘高于前阳高点，收盘在前阳实体中点以下
  if (pp.isBull && !lp.isBull
    && last.open > prev.high
    && last.close < (prev.open + prev.close) / 2
    && last.close > prev.open) {
    results.push(makeSignal(
      'darkCloudCover', '乌云盖顶', '双根', '做空', 65,
      `${nearLabel} 阻力位出现乌云盖顶，空头强力反扑`,
      '乌云盖顶形态出现，阴线深入前阳实体中点以下，看空信号较强',
    ));
  }

  // 12. 刺透形态（Piercing Line）：前阴后阳，阳线开盘低于前阴低点，收盘在前阴实体中点以上
  if (!pp.isBull && lp.isBull
    && last.open < prev.low
    && last.close > (prev.open + prev.close) / 2
    && last.close < prev.open) {
    results.push(makeSignal(
      'piercingLine', '刺透形态', '双根', '做多', 65,
      `${nearLabel} 支撑位出现刺透形态，多头强力反扑`,
      '刺透形态出现，阳线深入前阴实体中点以上，看多信号较强',
    ));
  }

  // ========================================
  // 三、三根K线组合
  // ========================================

  if (prev2 && p2p) {
    // 13. 启明星（Morning Star）：前大阴+中间小实体+后大阳，后阳收盘超过前阴实体中点
    if (!p2p.isBull
      && p2p.bodyRatio > 0.4
      && pp.bodyRatio < 0.3
      && lp.isBull
      && lp.bodyRatio > 0.4
      && last.close > (prev2.open + prev2.close) / 2) {
      results.push(makeSignal(
        'morningStar', '启明星', '三根', '做多', 75,
        `${nearLabel} 支撑位出现启明星，底部反转信号强烈`,
        '启明星形态出现，大阴+小实体+大阳组合，强烈看多反转',
      ));
    }

    // 14. 黄昏星（Evening Star）：前大阳+中间小实体+后大阴，后阴收盘低于前阳实体中点
    if (p2p.isBull
      && p2p.bodyRatio > 0.4
      && pp.bodyRatio < 0.3
      && !lp.isBull
      && lp.bodyRatio > 0.4
      && last.close < (prev2.open + prev2.close) / 2) {
      results.push(makeSignal(
        'eveningStar', '黄昏星', '三根', '做空', 75,
        `${nearLabel} 阻力位出现黄昏星，顶部反转信号强烈`,
        '黄昏星形态出现，大阳+小实体+大阴组合，强烈看空反转',
      ));
    }

    // 15. 三白兵（Three White Soldiers）：连续三根阳线，每根收盘高于前根，实体逐步增大
    if (p2p.isBull && pp.isBull && lp.isBull
      && prev.close > prev2.close
      && last.close > prev.close
      && pp.body >= p2p.body * 0.8
      && lp.body >= pp.body * 0.8
      && lp.body > p2p.body) {
      results.push(makeSignal(
        'threeWhiteSoldiers', '三白兵', '三根', '做多', 70,
        `${nearLabel} 附近出现三白兵，多头趋势强劲`,
        '三白兵形态出现，连续阳线且实体逐步增大，多头力量强劲',
      ));
    }

    // 16. 三只乌鸦（Three Black Crows）：连续三根阴线，每根收盘低于前根，实体逐步增大
    if (!p2p.isBull && !pp.isBull && !lp.isBull
      && prev.close < prev2.close
      && last.close < prev.close
      && pp.body >= p2p.body * 0.8
      && lp.body >= pp.body * 0.8
      && lp.body > p2p.body) {
      results.push(makeSignal(
        'threeBlackCrows', '三只乌鸦', '三根', '做空', 70,
        `${nearLabel} 附近出现三只乌鸦，空头趋势强劲`,
        '三只乌鸦形态出现，连续阴线且实体逐步增大，空头力量强劲',
      ));
    }
  }

  // 无形态时返回默认
  if (results.length === 0) {
    results.push({
      pattern: 'none', name: '无形态', category: '单根',
      nearLevel: null, nearLevelLabel: '', levelType: null,
      signal: '中性', confidence: 0,
      desc: '当前K线无显著形态',
    });
  }

  return results;
}

// ========== 裸K多空综合判断 ==========

/** 裸K多空综合判断结果 */
export interface NakedBullBearResult {
  /** 综合偏向：多/空/中性 */
  bias: '多' | '空' | '中性';
  /** 多空力量比 0~100，>50偏多，<50偏空 */
  bullBearRatio: number;
  /** 多头力量百分比 */
  bullPower: number;
  /** 空头力量百分比 */
  bearPower: number;
  /** 最近识别到的形态列表 */
  patterns: PatternSignal[];
  /** 一句话总结 */
  summary: string;
  /** 置信度 0-100 */
  confidence: number;
}

/**
 * 裸K多空综合判断
 * 综合分析最近K线的多空力量对比、连续趋势、形态确认
 * @param klines K线数据数组
 * @param fibLevels 斐波那契关键位（可选，用于增强形态确认）
 * @param lookback 兵力量化回溯K线数量，默认10
 */
export function analyzeNakedBullBear(
  klines: KlineData[],
  fibLevels: Record<number, number> = {},
  lookback: number = 10,
): NakedBullBearResult {
  if (klines.length < 3) {
    return {
      bias: '中性', bullBearRatio: 50, bullPower: 50, bearPower: 50,
      patterns: [], summary: '数据不足，无法判断', confidence: 0,
    };
  }

  const len = klines.length;
  const start = Math.max(0, len - lookback);
  const recent = klines.slice(start);

  // ===== 1. 兵力量化：多空力量对比 =====
  let bullBodySum = 0;  // 阳线实体总和
  let bearBodySum = 0;  // 阴线实体总和
  let bullCount = 0;
  let bearCount = 0;

  // 影线力量：下影线总和（买盘承接）vs 上影线总和（卖盘压力）
  let totalLowerWick = 0;
  let totalUpperWick = 0;

  for (const k of recent) {
    const body = Math.abs(k.close - k.open);
    const upperWick = k.high - Math.max(k.close, k.open);
    const lowerWick = Math.min(k.close, k.open) - k.low;

    if (k.close > k.open) {
      bullBodySum += body;
      bullCount++;
    } else if (k.close < k.open) {
      bearBodySum += body;
      bearCount++;
    }

    totalLowerWick += lowerWick;
    totalUpperWick += upperWick;
  }

  // 加权计算：实体力量权重1.0，影线力量权重0.5
  const bullForce = bullBodySum * 1.0 + totalLowerWick * 0.5;
  const bearForce = bearBodySum * 1.0 + totalUpperWick * 0.5;
  const totalForce = bullForce + bearForce;

  const bullPower = totalForce > 0 ? (bullForce / totalForce) * 100 : 50;
  const bearPower = totalForce > 0 ? (bearForce / totalForce) * 100 : 50;
  const bullBearRatio = totalForce > 0 ? (bullForce / totalForce) * 100 : 50;

  // ===== 2. 连续K线趋势 =====
  let consecBull = 0;
  let consecBear = 0;
  for (let i = len - 1; i >= 0; i--) {
    if (klines[i].close > klines[i].open) {
      if (consecBear === 0) consecBull++;
      else break;
    } else if (klines[i].close < klines[i].open) {
      if (consecBull === 0) consecBear++;
      else break;
    } else {
      break;
    }
  }

  // 连续同向K线加分（连续3根以上才加分，越多越强）
  let trendBonus = 0;
  if (consecBull >= 3) trendBonus = 10 + (consecBull - 3) * 3;
  else if (consecBear >= 3) trendBonus = -(10 + (consecBear - 3) * 3);

  // ===== 3. K线形态识别 =====
  const patterns = detectCandlePatterns(klines, fibLevels);

  // 形态信号评分（仅统计有效形态，排除'none'）
  let patternScore = 0;
  let patternCount = 0;
  for (const p of patterns) {
    if (p.pattern === 'none') continue;
    patternCount++;
    if (p.signal === '做多') patternScore += p.confidence * 0.8;
    else if (p.signal === '做空') patternScore -= p.confidence * 0.8;
  }

  // ===== 4. 综合计算 =====
  // 力量比偏离50的程度
  const powerDeviation = bullBearRatio - 50;
  // 综合得分 = 力量偏离 + 趋势加分 + 形态加分
  const compositeScore = powerDeviation + trendBonus + (patternCount > 0 ? patternScore / patternCount : 0);

  // 判定偏向和置信度
  let bias: '多' | '空' | '中性';
  let confidence: number;
  const absScore = Math.abs(compositeScore);

  if (absScore < 5) {
    bias = '中性';
    confidence = Math.max(0, Math.min(20, Math.round(20 - absScore * 4)));
  } else if (compositeScore > 0) {
    bias = '多';
    confidence = Math.min(95, Math.round(40 + absScore * 0.8));
  } else {
    bias = '空';
    confidence = Math.min(95, Math.round(40 + absScore * 0.8));
  }

  // ===== 5. 生成一句话总结 =====
  const trendStr = consecBull >= 2 ? `连续${consecBull}根阳线`
    : consecBear >= 2 ? `连续${consecBear}根阴线`
    : '多空交替';

  const validPatterns = patterns.filter(p => p.pattern !== 'none');
  const patternStr = validPatterns.length > 0
    ? validPatterns.map(p => p.name).join('、')
    : '无明显形态';

  const ratioDesc = bullBearRatio > 60 ? '多头占优'
    : bullBearRatio < 40 ? '空头占优'
    : '多空均衡';

  let summary: string;
  if (bias === '多') {
    summary = `偏多 | ${ratioDesc}(${bullBearRatio.toFixed(0)}%)，${trendStr}，${patternStr}`;
  } else if (bias === '空') {
    summary = `偏空 | ${ratioDesc}(${bullBearRatio.toFixed(0)}%)，${trendStr}，${patternStr}`;
  } else {
    summary = `中性 | ${ratioDesc}(${bullBearRatio.toFixed(0)}%)，${trendStr}，${patternStr}`;
  }

  return {
    bias,
    bullBearRatio: Math.round(bullBearRatio * 10) / 10,
    bullPower: Math.round(bullPower * 10) / 10,
    bearPower: Math.round(bearPower * 10) / 10,
    patterns,
    summary,
    confidence,
  };
}

// ========== 布林带状态检测 ==========

export interface BollingerState {
  /** 带宽（上轨-下轨）/ 中轨 * 100，反映波动率 */
  bandwidth: number;
  /** 带宽状态 */
  squeeze: '极窄（即将突破）' | '收窄' | '正常' | '扩张' | '极宽';
  /** 价格在布林带中的位置 0~100（0=下轨，100=上轨）*/
  pricePosition: number;
  /** 价格位置描述 */
  positionDesc: string;
  /** 中轨方向 */
  midTrend: '上行' | '走平' | '下行';
  /** 综合信号 */
  signal: string;
}

export function analyzeBollingerState(klines: KlineData[]): BollingerState | null {
  const boll = calcBollinger(klines);
  if (!boll || !boll.upperSeries || boll.upperSeries.length === 0) return null;
  const series = boll.upperSeries;
  const midSeries = boll.middleSeries;
  const lastIdx = series.length - 1;
  const upper = boll.upper;
  const mid = boll.middle;
  const lower = boll.lower;
  if (!upper || !mid || !lower) return null;

  const bandwidth = mid > 0 ? ((upper - lower) / mid) * 100 : 0;
  const currentClose = klines[klines.length - 1].close;
  const pricePos = (upper - lower) > 0
    ? ((currentClose - lower) / (upper - lower)) * 100
    : 50;

  // 带宽状态
  let squeeze: BollingerState['squeeze'];
  if (bandwidth < 2) squeeze = '极窄（即将突破）';
  else if (bandwidth < 4) squeeze = '收窄';
  else if (bandwidth < 8) squeeze = '正常';
  else if (bandwidth < 12) squeeze = '扩张';
  else squeeze = '极宽';

  // 价格位置
  let positionDesc: string;
  if (pricePos > 90) positionDesc = '贴近上轨，超买区域';
  else if (pricePos > 70) positionDesc = '上轨附近，偏强';
  else if (pricePos < 10) positionDesc = '贴近下轨，超卖区域';
  else if (pricePos < 30) positionDesc = '下轨附近，偏弱';
  else positionDesc = '中轨附近，中性区';

  // 中轨方向（对比5根前）
  const midPrev = midSeries[lastIdx - 5]?.value || mid;
  let midTrend: BollingerState['midTrend'];
  if (mid > midPrev * 1.002) midTrend = '上行';
  else if (mid < midPrev * 0.998) midTrend = '下行';
  else midTrend = '走平';

  // 综合信号
  let signal: string;
  if (squeeze === '极窄（即将突破）') {
    signal = pricePos > 50 ? '收口末端偏上，向上突破概率大' : '收口末端偏下，向下突破概率大';
  } else if (squeeze === '收窄' && midTrend === '走平') {
    signal = '布林带收窄 + 中轨走平，蓄势中，等待方向选择';
  } else if (pricePos > 90) {
    signal = '贴近上轨，注意回落风险';
  } else if (pricePos < 10) {
    signal = '贴近下轨，可能有反弹';
  } else if (midTrend === '上行' && pricePos > 50) {
    signal = '布林带开口向上，趋势偏多';
  } else if (midTrend === '下行' && pricePos < 50) {
    signal = '布林带开口向下，趋势偏空';
  } else {
    signal = '布林带无明确信号';
  }

  return {
    bandwidth: Math.round(bandwidth * 100) / 100,
    squeeze,
    pricePosition: Math.round(pricePos),
    positionDesc,
    midTrend,
    signal,
  };
}

// EMA 数组
export function calcEMAArray(klines: KlineData[], period: number): number[] {
  const closes = klines.map((k) => k.close);
  return ema(closes, period);
}

/**
 * 趋势判断（基于 EMA 均线，不依赖 AB9）
 * 支持按周期自适应：短周期用长期均线更稳定
 * fastPeriod < slowPeriod 且 收盘价在慢均线上方 = 多
 * fastPeriod > slowPeriod 且 收盘价在慢均线下方 = 空
 * 否则 = 震荡
 */
export function detectTrend(
  klines: KlineData[],
  fastPeriod: number = 20,
  slowPeriod: number = 50
): 'up' | 'down' | 'sideways' {
  if (klines.length < slowPeriod + 10) return 'sideways';
  const fastArr = calcEMAArray(klines, fastPeriod);
  const slowArr = calcEMAArray(klines, slowPeriod);
  const lastFast = fastArr[fastArr.length - 1];
  const lastSlow = slowArr[slowArr.length - 1];
  const lastClose = klines[klines.length - 1].close;

  if (lastFast > lastSlow && lastClose > lastSlow) return 'up';
  if (lastFast < lastSlow && lastClose < lastSlow) return 'down';
  return 'sideways';
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

/**
 * 反转K线形态检测
 * 检测最近一根K线是否为：锤子线/倒锤子/看涨吞没/看跌吞没/pin bar
 * 返回形态名称和方向（bullish/bearish/null）
 */
export interface ReversalPattern {
  type: string;       // '锤子线' | '倒锤子' | '看涨吞没' | '看跌吞没' | '看涨PinBar' | '看跌PinBar'
  direction: 'bullish' | 'bearish' | null;
  index: number;      // 在K线数组中的位置
  strength: number;   // 1-3 强度
}

export function detectReversalPattern(klines: KlineData[]): ReversalPattern | null {
  if (klines.length < 3) return null;
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const body = Math.abs(last.close - last.open);
  const totalRange = last.high - last.low;
  const upperShadow = last.high - Math.max(last.close, last.open);
  const lowerShadow = Math.min(last.close, last.open) - last.low;

  if (totalRange === 0) return null;

  // 1. 锤子线（做多反转）：下影线 >= 2倍实体，上影线 <= 实体0.3倍
  if (lowerShadow >= body * 2 && upperShadow <= body * 0.3 && body > 0) {
    return { type: '锤子线', direction: 'bullish', index: klines.length - 1, strength: lowerShadow >= body * 3 ? 3 : 2 };
  }

  // 2. 倒锤子（做多反转）：上影线 >= 2倍实体，下影线 <= 实体0.3倍
  if (upperShadow >= body * 2 && lowerShadow <= body * 0.3 && body > 0) {
    return { type: '倒锤子', direction: 'bullish', index: klines.length - 1, strength: upperShadow >= body * 3 ? 3 : 2 };
  }

  // 3. 看涨吞没：当前阳线完全包含前一根阴线
  if (last.close > last.open && prev.close < prev.open &&
      last.open <= prev.close && last.close >= prev.open &&
      body > Math.abs(prev.close - prev.open) * 0.8) {
    return { type: '看涨吞没', direction: 'bullish', index: klines.length - 1, strength: 3 };
  }

  // 4. 看跌吞没：当前阴线完全包含前一根阳线
  if (last.close < last.open && prev.close > prev.open &&
      last.open >= prev.close && last.close <= prev.open &&
      body > Math.abs(prev.close - prev.open) * 0.8) {
    return { type: '看跌吞没', direction: 'bearish', index: klines.length - 1, strength: 3 };
  }

  // 5. 看涨PinBar：实体很小（<= 总幅度的1/3），下影线 >= 总幅度60%
  if (body <= totalRange / 3 && lowerShadow >= totalRange * 0.6) {
    return { type: '看涨PinBar', direction: 'bullish', index: klines.length - 1, strength: lowerShadow >= totalRange * 0.75 ? 3 : 2 };
  }

  // 6. 看跌PinBar：实体很小（<= 总幅度的1/3），上影线 >= 总幅度60%
  if (body <= totalRange / 3 && upperShadow >= totalRange * 0.6) {
    return { type: '看跌PinBar', direction: 'bearish', index: klines.length - 1, strength: upperShadow >= totalRange * 0.75 ? 3 : 2 };
  }

  return null;
}

/**
 * 日内信号分析：MACD + 蜡烛图 + 顶底分型
 * 在窗口期（最近 window 根K线）内，三个信号先后出现且方向一致即触发
 * 不要求同一根K线同时满足
 */
export interface EntrySignal {
  direction: 'bullish' | 'bearish' | null;
  macd: boolean;
  candle: boolean;
  fractal: boolean;
  macdDesc: string;
  candleDesc: string;
  fractalDesc: string;
  macdBarAgo: number;     // MACD信号在几根K线前出现（0=当前）
  candleBarAgo: number;
  fractalBarAgo: number;
  triggered: boolean;
  strength: number;
}

export function detectEntrySignal(
  klines: KlineData[],
  fractals: FractalPattern[],
  window: number = 5
): EntrySignal {
  const result: EntrySignal = {
    direction: null,
    macd: false,
    candle: false,
    fractal: false,
    macdDesc: '无信号',
    candleDesc: '无反转形态',
    fractalDesc: '无分型',
    macdBarAgo: -1,
    candleBarAgo: -1,
    fractalBarAgo: -1,
    triggered: false,
    strength: 0,
  };

  if (klines.length < 35) return result;
  const n = klines.length;

  // === 1. MACD 信号（改进版：只认金叉/死叉 + 零轴距离过滤） ===
  const macd = calcMACD(klines);
  if (macd) {
    const histArr = (macd.hist.filter((h) => h !== null) as number[]);
    const difArr = (macd.dif.filter((d) => d !== null) as number[]);
    const deaArr = (macd.dea.filter((d) => d !== null) as number[]);

    // 计算近期 MACD 柱体的平均绝对值，用于判断零轴距离
    const recentHists = histArr.slice(-20);
    const avgHist = recentHists.length > 0
      ? recentHists.reduce((s, v) => s + Math.abs(v), 0) / recentHists.length
      : 0;

    for (let i = 0; i < window && i < histArr.length; i++) {
      const idx = histArr.length - 1 - i;
      if (idx < 2) break;
      const hist = histArr[idx];
      const prevHist = histArr[idx - 1];
      const prevPrevHist = histArr[idx - 2];
      const dif = difArr[Math.min(idx, difArr.length - 1)];
      const dea = deaArr[Math.min(idx, deaArr.length - 1)];

      // --- 做多信号 ---
      // 金叉：hist 从 <=0 变为 >0，且 DIF/DEA 在零轴附近（非高位金叉）
      if (dif > dea && hist > 0 && prevHist <= 0) {
        // 零轴距离过滤：DIF 绝对值不超过近期平均柱体的 2.5 倍
        // 高位金叉（DIF 远离零轴）往往是趋势末端，准确率低
        if (Math.abs(dif) < avgHist * 2.5 || avgHist < 1) {
          result.macd = true;
          result.macdBarAgo = i;
          result.macdDesc = `MACD金叉(${i}根前)`;
          if (!result.direction) result.direction = 'bullish';
          break;
        }
      }
      // DIF 底背离：价格创新低但 DIF 未创新低，更可靠的看多信号
      if (i === 0 && dif > dea && hist > 0) {
        const lookback = Math.min(20, histArr.length);
        let priceNewLow = false;
        let difNewLow = false;
        const priceSlice = klines.slice(-lookback);
        const difSlice = difArr.slice(-lookback);
        if (priceSlice.length >= 10 && difSlice.length >= 10) {
          const recentPriceLow = Math.min(...priceSlice.slice(-5).map(k => k.low));
          const earlierPriceLow = Math.min(...priceSlice.slice(0, -5).map(k => k.low));
          priceNewLow = recentPriceLow < earlierPriceLow;
          const recentDifMin = Math.min(...difSlice.slice(-5));
          const earlierDifMin = Math.min(...difSlice.slice(0, -5));
          difNewLow = recentDifMin < earlierDifMin;
          // 价格创新低 + DIF 没创新低 = 底背离
          if (priceNewLow && !difNewLow) {
            result.macd = true;
            result.macdBarAgo = 0;
            result.macdDesc = 'MACD底背离';
            if (!result.direction) result.direction = 'bullish';
            break;
          }
        }
      }

      // --- 做空信号 ---
      if (dif < dea && hist < 0 && prevHist >= 0) {
        if (Math.abs(dif) < avgHist * 2.5 || avgHist < 1) {
          result.macd = true;
          result.macdBarAgo = i;
          result.macdDesc = `MACD死叉(${i}根前)`;
          if (!result.direction) result.direction = 'bearish';
          break;
        }
      }
      // DIF 顶背离
      if (i === 0 && dif < dea && hist < 0) {
        const lookback = Math.min(20, histArr.length);
        let priceNewHigh = false;
        let difNewHigh = false;
        const priceSlice = klines.slice(-lookback);
        const difSlice = difArr.slice(-lookback);
        if (priceSlice.length >= 10 && difSlice.length >= 10) {
          const recentPriceHigh = Math.max(...priceSlice.slice(-5).map(k => k.high));
          const earlierPriceHigh = Math.max(...priceSlice.slice(0, -5).map(k => k.high));
          priceNewHigh = recentPriceHigh > earlierPriceHigh;
          const recentDifMax = Math.max(...difSlice.slice(-5));
          const earlierDifMax = Math.max(...difSlice.slice(0, -5));
          difNewHigh = recentDifMax > earlierDifMax;
          if (priceNewHigh && !difNewHigh) {
            result.macd = true;
            result.macdBarAgo = 0;
            result.macdDesc = 'MACD顶背离';
            if (!result.direction) result.direction = 'bearish';
            break;
          }
        }
      }
    }
    if (!result.macd) {
      const lastHist = histArr[histArr.length - 1] || 0;
      result.macdDesc = lastHist > 0 ? 'MACD多头' : lastHist < 0 ? 'MACD空头' : 'MACD中性';
    }
  }

  // === 2. 蜡烛图信号（改进版：加趋势上下文 + 成交量确认） ===
  // 计算近期均线斜率判断短期趋势方向
  const recentCloses = klines.slice(-10).map(k => k.close);
  const shortTrendDown = recentCloses.length >= 8
    ? recentCloses[recentCloses.length - 1] < recentCloses[0] - (recentCloses[0] * 0.001)
    : false;  // 近10根K线整体下跌超过0.1%
  const shortTrendUp = recentCloses.length >= 8
    ? recentCloses[recentCloses.length - 1] > recentCloses[0] + (recentCloses[0] * 0.001)
    : false;
  // 近期平均成交量
  const avgVol = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / Math.min(20, klines.length);

  for (let i = 0; i < window && i < n - 2; i++) {
    const slice = klines.slice(0, n - i);
    const candle = detectReversalPattern(slice);
    if (candle) {
      // 趋势上下文过滤：
      // - 看涨形态要求之前处于下跌趋势中（短期趋势向下），否则忽略
      // - 看跌形态要求之前处于上涨趋势中（短期趋势向上），否则忽略
      const contextOk =
        (candle.direction === 'bullish' && shortTrendDown) ||
        (candle.direction === 'bearish' && shortTrendUp);

      // 成交量确认：反转K线的成交量 >= 近期平均的 0.8 倍
      const volOk = slice[slice.length - 1].volume >= avgVol * 0.8;

      if (contextOk && volOk) {
        if (!result.direction || candle.direction === result.direction) {
          result.candle = true;
          result.candleBarAgo = i;
          result.candleDesc = `${candle.type}(${i}根前)`;
          if (!result.direction) result.direction = candle.direction;
        }
        break;
      }
      // 如果趋势上下文通过但成交量不足，记录为弱信号描述
      if (contextOk && !volOk) {
        result.candleDesc = `${candle.type}(量不足)`;
        break;
      }
      // 如果趋势上下文不通过，继续往前找
    }
  }
  if (!result.candle && !result.candleDesc.startsWith('量不足') && !result.candleDesc.startsWith('趋势不符')) {
    // 保留已设置的描述（如"锤子线(量不足)"）
    if (!result.candleDesc || result.candleDesc === '无反转形态') {
      result.candleDesc = '无反转形态';
    }
  }

  // === 3. 分型信号（改进版：收紧窗口 + 价格位置确认） ===
  const recentFractals = fractals.filter((f) => f.status === 'confirmed');
  const fractalWindow = Math.min(window, 3); // 分型窗口收紧到3根，减少滞后
  for (let i = recentFractals.length - 1; i >= 0; i--) {
    const f = recentFractals[i];
    const barAgo = n - 1 - (f.centerIdx || 0);
    if (barAgo < 0 || barAgo > fractalWindow) continue;

    if (f.type === '底分型' && (!result.direction || result.direction === 'bullish')) {
      // 底分型的低点应该低于近5根K线的最低价中位数（确认是真正的支撑位）
      const recentLows = klines.slice(-6, -1).map(k => k.low);
      const medianLow = recentLows.length > 0
        ? [...recentLows].sort((a, b) => a - b)[Math.floor(recentLows.length / 2)]
        : Infinity;
      const fractalLow = f.low ?? 0;
      if (fractalLow <= medianLow * 1.002 || medianLow === Infinity) {
        result.fractal = true;
        result.fractalBarAgo = barAgo;
        result.fractalDesc = `底分型(${barAgo}根前)`;
        if (!result.direction) result.direction = 'bullish';
        break;
      } else {
        result.fractalDesc = `底分型(位置偏高)`;
        break;
      }
    }
    if (f.type === '顶分型' && (!result.direction || result.direction === 'bearish')) {
      const recentHighs = klines.slice(-6, -1).map(k => k.high);
      const medianHigh = recentHighs.length > 0
        ? [...recentHighs].sort((a, b) => a - b)[Math.floor(recentHighs.length / 2)]
        : 0;
      const fractalHigh = f.high ?? 0;
      if (fractalHigh >= medianHigh * 0.998 || medianHigh === 0) {
        result.fractal = true;
        result.fractalBarAgo = barAgo;
        result.fractalDesc = `顶分型(${barAgo}根前)`;
        if (!result.direction) result.direction = 'bearish';
        break;
      } else {
        result.fractalDesc = `顶分型(位置偏低)`;
        break;
      }
    }
  }
  if (!result.fractal && !result.fractalDesc.includes('位置')) {
    result.fractalDesc = recentFractals.length > 0 ? `${recentFractals[recentFractals.length - 1].type}超出窗口` : '无分型';
  }

  // === 综合判断 ===
  if (result.macd) result.strength++;
  if (result.candle) result.strength++;
  if (result.fractal) result.strength++;
  result.triggered = result.macd && result.candle && result.fractal;

  return result;
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

export interface MultiTFFibData {
  [timeframe: string]: FibonacciData | null;
}

export interface ResonanceZone {
  levelKey: number;
  levelLabel: string;
  price: number;
  timeframes: string[];
  count: number;
}

const RESONANCE_LEVEL_KEYS = [0, 236, 382, 50, 618, 786, 100, 1272, 1618];
const RESONANCE_LEVEL_LABELS: Record<number, string> = {
  0: '0.0', 236: '0.236', 382: '0.382', 50: '0.5',
  618: '0.618', 786: '0.786', 100: '1.0', 1272: 'E1.272', 1618: 'E1.618',
};

/**
 * 在多个时间框架的斐波那契数据中寻找共振区：
 * 当 2 个或以上的时间框架在同一 levelKey 上的价格差距 < threshold% 时，
 * 认为该位置产生了共振。
 */
export function findResonanceZones(
  multiTF: MultiTFFibData,
  threshold: number = 0.5,
): ResonanceZone[] {
  const zones: ResonanceZone[] = [];

  for (const key of RESONANCE_LEVEL_KEYS) {
    // 收集所有时间框架在该 levelKey 上的有效价格
    const entries: { tf: string; price: number }[] = [];
    for (const [tf, fib] of Object.entries(multiTF)) {
      if (!fib) continue;
      const price = fib.levels[key];
      if (price && price > 0) {
        entries.push({ tf, price });
      }
    }

    if (entries.length < 2) continue;

    // 贪心聚类：找到最大的一组互相在 threshold% 以内的价格
    let bestGroup: typeof entries = [];
    for (let i = 0; i < entries.length; i++) {
      const group = [entries[i]];
      for (let j = i + 1; j < entries.length; j++) {
        const refPrice = group[0].price;
        const pctDiff = Math.abs(entries[j].price - refPrice) / refPrice * 100;
        if (pctDiff <= threshold) {
          group.push(entries[j]);
        }
      }
      if (group.length > bestGroup.length) {
        bestGroup = group;
      }
    }

    if (bestGroup.length >= 2) {
      const avgPrice = bestGroup.reduce((s, e) => s + e.price, 0) / bestGroup.length;
      zones.push({
        levelKey: key,
        levelLabel: RESONANCE_LEVEL_LABELS[key] || String(key),
        price: avgPrice,
        timeframes: bestGroup.map((e) => e.tf),
        count: bestGroup.length,
      });
    }
  }

  // 按共振周期数降序，再按 levelKey 升序
  zones.sort((a, b) => b.count - a.count || a.levelKey - b.levelKey);
  return zones;
}

// ========== 势能分析 ==========

export interface MomentumAnalysis {
  rsi: number;
  rsiSignal: '超买' | '超卖' | '中性偏多' | '中性偏空' | '中性';
  volumeTrend: '放量' | '缩量' | '平稳';
  volumeRatio: number;       // 近5均量 / 远10均量
  priceMomentum: '强多' | '偏多' | '偏空' | '强空' | '震荡';
  momentumScore: number;     // -100 ~ +100
  overallBias: '多头占优' | '空头占优' | '多空均衡';
  /** 突破各斐波那契位的概率 0~100 */
  breakProbabilities: Record<number, number>;
}

export function analyzeMomentum(klines: KlineData[], fibLevels: Record<number, number>): MomentumAnalysis {
  const len = klines.length;
  if (len < 30) {
    const empty: Record<number, number> = {};
    for (const k of [236, 382, 50, 618, 786]) empty[k] = 50;
    return {
      rsi: 50, rsiSignal: '中性', volumeTrend: '平稳', volumeRatio: 1,
      priceMomentum: '震荡', momentumScore: 0, overallBias: '多空均衡',
      breakProbabilities: empty,
    };
  }

  // --- RSI(14) ---
  const rsi = calcRSI(klines, 14) || 50;
  let rsiSignal: MomentumAnalysis['rsiSignal'] = '中性';
  if (rsi >= 70) rsiSignal = '超买';
  else if (rsi <= 30) rsiSignal = '超卖';
  else if (rsi >= 55) rsiSignal = '中性偏多';
  else if (rsi <= 45) rsiSignal = '中性偏空';

  // --- 成交量趋势 ---
  const recentVol = klines.slice(-5).reduce((s, k) => s + k.volume, 0) / 5;
  const olderVol = klines.slice(-15, -5).reduce((s, k) => s + k.volume, 0) / 10;
  const volRatio = olderVol > 0 ? recentVol / olderVol : 1;
  let volumeTrend: MomentumAnalysis['volumeTrend'] = '平稳';
  if (volRatio > 1.3) volumeTrend = '放量';
  else if (volRatio < 0.7) volumeTrend = '缩量';

  // --- 价格动量（近10根K线涨跌幅 + 收盘价相对MA20位置） ---
  const closes10 = klines.slice(-10).map((k) => k.close);
  const mom10 = ((closes10[closes10.length - 1] - closes10[0]) / closes10[0]) * 100;

  const closes20 = klines.slice(-20).map((k) => k.close);
  const ma20 = closes20.reduce((s, c) => s + c, 0) / closes20.length;
  const currentClose = klines[len - 1].close;
  const aboveMA20 = currentClose > ma20 ? 1 : -1;
  const distFromMA20 = ((currentClose - ma20) / ma20) * 100;

  let priceMomentum: MomentumAnalysis['priceMomentum'] = '震荡';
  if (mom10 > 2 && aboveMA20 > 0) priceMomentum = '强多';
  else if (mom10 > 0.5 && aboveMA20 > 0) priceMomentum = '偏多';
  else if (mom10 < -2 && aboveMA20 < 0) priceMomentum = '强空';
  else if (mom10 < -0.5 && aboveMA20 < 0) priceMomentum = '偏空';

  // --- 综合评分 -100 ~ +100 ---
  let score = 0;
  // RSI 贡献 ±30
  if (rsi >= 70) score -= 25;
  else if (rsi <= 30) score += 25;
  else if (rsi >= 55) score += (rsi - 50) * 0.6;
  else if (rsi <= 45) score += (rsi - 50) * 0.6;
  // 动量贡献 ±30
  score += Math.max(-30, Math.min(30, mom10 * 6));
  // MA20 位置贡献 ±15
  score += Math.max(-15, Math.min(15, distFromMA20 * 15));
  // 量能贡献 ±15
  if (volumeTrend === '放量' && aboveMA20 > 0) score += 12;
  else if (volumeTrend === '放量' && aboveMA20 < 0) score -= 12;
  else if (volumeTrend === '缩量') score -= 3;

  score = Math.max(-100, Math.min(100, score));
  let overallBias: MomentumAnalysis['overallBias'] = '多空均衡';
  if (score > 15) overallBias = '多头占优';
  else if (score < -15) overallBias = '空头占优';

  // --- 突破概率计算 ---
  // 基于评分 + 距离 + RSI + 量能
  const breakProbabilities: Record<number, number> = {};
  const resistanceKeys = [0, 236, 382, 50, 618, 786, 100];
  for (const key of resistanceKeys) {
    const levelPrice = fibLevels[key];
    if (!levelPrice || levelPrice <= 0) { breakProbabilities[key] = 50; continue; }

    const dist = ((levelPrice - currentClose) / currentClose) * 100;
    const absDist = Math.abs(dist);
    const isAbove = dist > 0; // 阻力位在上方

    // 基础概率：距离越近越容易突破
    let prob = Math.max(10, Math.min(90, 60 - absDist * 8));

    // 动量修正
    if (isAbove) {
      // 向上突破阻力位
      prob += score * 0.2;
      if (volumeTrend === '放量') prob += 8;
      if (rsi < 70) prob += 5;
    } else {
      // 向下跌破支撑位
      prob -= score * 0.2;
      if (volumeTrend === '放量') prob += 8;
      if (rsi > 30) prob += 5;
    }

    breakProbabilities[key] = Math.round(Math.max(5, Math.min(95, prob)));
  }

  return {
    rsi: Math.round(rsi * 10) / 10,
    rsiSignal,
    volumeTrend,
    volumeRatio: Math.round(volRatio * 100) / 100,
    priceMomentum,
    momentumScore: Math.round(score),
    overallBias,
    breakProbabilities,
  };
}

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

export function analyzeLevelTests(
  klines: KlineData[],
  levels: Record<number, number>,
  tolerancePct: number = 0.15,
): Record<number, LevelTest> {
  const result: Record<number, LevelTest> = {};

  // 整体均量
  const totalVol = klines.reduce((s, k) => s + k.volume, 0);
  const avgVol = totalVol / klines.length;

  for (const [keyStr, levelPrice] of Object.entries(levels)) {
    const key = Number(keyStr);
    if (!levelPrice || levelPrice <= 0) continue;

    const tol = levelPrice * (tolerancePct / 100);
    const touches: { idx: number; bouncePct: number; vol: number; wickLen: number }[] = [];

    for (let i = 2; i < klines.length - 2; i++) {
      const k = klines[i];
      const isNear =
        (k.low <= levelPrice + tol && k.low >= levelPrice - tol) ||
        (k.high >= levelPrice - tol && k.high <= levelPrice + tol);

      if (!isNear) continue;

      // 判断是触及支撑（在上方）还是阻力（在下方）
      const prevClose = klines[i - 1].close;
      const isSupport = prevClose > levelPrice;
      const isResistance = prevClose < levelPrice;

      // 计算反弹幅度：触及后 1~3 根K线的最大偏离
      let maxBounce = 0;
      for (let j = i + 1; j <= Math.min(i + 3, klines.length - 1); j++) {
        const after = klines[j];
        if (isSupport) {
          const bounce = ((after.high - levelPrice) / levelPrice) * 100;
          maxBounce = Math.max(maxBounce, bounce);
        } else if (isResistance) {
          const bounce = ((levelPrice - after.low) / levelPrice) * 100;
          maxBounce = Math.max(maxBounce, bounce);
        }
      }

      // K线影线长度（针尖）
      const wickLen = isSupport
        ? ((k.close - k.low) / k.close) * 100
        : ((k.high - k.close) / k.close) * 100;

      touches.push({
        idx: i,
        bouncePct: isSupport || isResistance ? maxBounce : 0,
        vol: k.volume,
        wickLen: Math.abs(wickLen),
      });
    }

    // 合并距离太近的触及（5根K线内只算一次）
    const merged: typeof touches = [];
    for (const t of touches) {
      if (merged.length > 0 && t.idx - merged[merged.length - 1].idx < 5) continue;
      merged.push(t);
    }
    const finalTouches = merged;
    const touchCount = finalTouches.length;

    if (touchCount === 0) {
      result[key] = {
        touches: 0, bouncePcts: [], avgTouchVolRatio: 0,
        verdict: '未测试', strength: 50, signal: '尚未触及，等待验证',
      };
      continue;
    }

    const bouncePcts = finalTouches.map((t) => Math.round(t.bouncePct * 100) / 100);
    const avgBounce = bouncePcts.reduce((s, v) => s + v, 0) / bouncePcts.length;
    const touchVols = finalTouches.map((t) => t.vol);
    const avgTouchVol = touchVols.reduce((s, v) => s + v, 0) / touchVols.length;
    const avgTouchVolRatio = avgVol > 0 ? Math.round((avgTouchVol / avgVol) * 100) / 100 : 1;

    // 判定结实还是衰减
    let verdict: LevelTest['verdict'];
    let strength: number;
    let signal: string;

    if (touchCount < 2) {
      verdict = '未测试';
      strength = 40;
      signal = `仅触及 ${touchCount} 次，需更多验证`;
    } else {
      // 检查反弹幅度是否递减
      let decaying = false;
      let stable = true;
      for (let i = 1; i < bouncePcts.length; i++) {
        if (bouncePcts[i] < bouncePcts[i - 1] * 0.6) decaying = true;
        if (Math.abs(bouncePcts[i] - bouncePcts[i - 1]) / Math.max(bouncePcts[i - 1], 0.01) > 0.5) stable = false;
      }

      // 检查触及时量能
      const highVolTouches = finalTouches.filter((t) => t.vol > avgVol * 1.2).length;
      const highVolRatio = highVolTouches / touchCount;

      if (decaying) {
        verdict = '衰减';
        strength = Math.max(10, Math.round(30 - touchCount * 3 + (1 - highVolRatio) * 20));
        signal = `反弹递减，${touchCount}次测试后力量衰减，留意突破`;
      } else if (stable || bouncePcts[bouncePcts.length - 1] >= avgBounce * 0.8) {
        verdict = '结实';
        strength = Math.min(95, Math.round(50 + touchCount * 8 + highVolRatio * 20));
        signal = `${touchCount}次测试未破，${highVolRatio > 0.5 ? '放量验证' : '反复确认'}，该位有效`;
      } else {
        verdict = '衰减';
        strength = Math.round(40);
        signal = `${touchCount}次触及但信号不明确，继续观察`;
      }

      // 超过5次反转判断
      if (touchCount >= 5 && verdict === '结实') {
        strength = Math.min(90, strength - 10);
        signal += '，但测试次数过多需防假突破';
      }
    }

    result[key] = {
      touches: touchCount,
      bouncePcts,
      avgTouchVolRatio,
      verdict,
      strength,
      signal,
    };
  }

  return result;
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

export function calcATRStopLoss(
  entryPrice: number,
  klines: KlineData[],
  direction: '做多' | '做空',
  multiplier: number = 1.5,
): number {
  const atr = calcATR(klines, 14);
  if (atr <= 0) {
    return direction === '做多' ? entryPrice * 0.993 : entryPrice * 1.007;
  }
  const stopDistance = atr * multiplier;
  return direction === '做多' ? entryPrice - stopDistance : entryPrice + stopDistance;
}

// ========== 多周期趋势过滤 ==========

export interface MultiTimeframeBias {
  /** 大周期方向 */
  higherTF: '上升' | '下降' | '盘整';
  /** 中周期方向 */
  midTF: '上升' | '下降' | '盘整';
  /** 综合交易方向建议 */
  tradingDirection: '做多' | '做空' | '观望';
  /** 是否多周期共振 */
  isConfluence: boolean;
  /** 说明文字 */
  summary: string;
}

export function analyzeMultiTimeframeBias(
  higherTFStructure: MarketStructure | null,
  midTFStructure: MarketStructure | null,
): MultiTimeframeBias {
  const higher = higherTFStructure?.trend || '盘整';
  const mid = midTFStructure?.trend || '盘整';

  let tradingDirection: '做多' | '做空' | '观望';
  let isConfluence = false;
  let summary: string;

  if (higher === '上升' && mid === '上升') {
    tradingDirection = '做多';
    isConfluence = true;
    summary = '大周期上升 + 中周期上升，共振做多，回踩入场';
  } else if (higher === '下降' && mid === '下降') {
    tradingDirection = '做空';
    isConfluence = true;
    summary = '大周期下降 + 中周期下降，共振做空，反弹入场';
  } else if (higher === '上升' && mid === '下降') {
    tradingDirection = '观望';
    isConfluence = false;
    summary = '大周期上升但中周期回调中，等待中周期企稳再考虑做多';
  } else if (higher === '下降' && mid === '上升') {
    tradingDirection = '观望';
    isConfluence = false;
    summary = '大周期下降但中周期反弹中，等待中周期遇阻再考虑做空';
  } else if (higher === '盘整') {
    tradingDirection = mid === '上升' ? '做多' : mid === '下降' ? '做空' : '观望';
    isConfluence = false;
    summary = `大周期盘整，中周期${mid}，按中周期方向轻仓操作`;
  } else {
    tradingDirection = '观望';
    isConfluence = false;
    summary = '方向不明确，建议观望';
  }

  return { higherTF: higher, midTF: mid, tradingDirection, isConfluence, summary };
}

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

export function detectFVG(klines: KlineData[], maxLookback: number = 50): FVG[] {
  const fvgs: FVG[] = [];
  const len = klines.length;
  const start = Math.max(2, len - maxLookback);

  for (let i = start; i < len; i++) {
    const prev = klines[i - 2];
    const curr = klines[i - 1];

    // 看涨 FVG：中间K线低点 > 前一根K线高点
    if (curr.low > prev.high) {
      const size = ((curr.low - prev.high) / prev.high) * 100;
      let isActive = true;
      for (let j = i; j < len; j++) {
        if (klines[j].low <= prev.high) {
          isActive = false;
          break;
        }
      }
      fvgs.push({
        type: 'bullish',
        start: curr.low,
        end: prev.high,
        startTime: curr.time,
        endTime: klines[i].time,
        size: Math.round(size * 100) / 100,
        isActive,
        index: i - 1,
      });
    }

    // 看跌 FVG：中间K线高点 < 前一根K线低点
    if (curr.high < prev.low) {
      const size = ((prev.low - curr.high) / prev.low) * 100;
      let isActive = true;
      for (let j = i; j < len; j++) {
        if (klines[j].high >= prev.low) {
          isActive = false;
          break;
        }
      }
      fvgs.push({
        type: 'bearish',
        start: prev.low,
        end: curr.high,
        startTime: curr.time,
        endTime: klines[i].time,
        size: Math.round(size * 100) / 100,
        isActive,
        index: i - 1,
      });
    }
  }

  return fvgs.filter((f) => f.isActive).sort((a, b) => b.size - a.size);
}

// ========== 订单块 (Order Block) 识别 ==========

export interface OrderBlock {
  type: 'bullish' | 'bearish';
  /** OB 上沿 */
  top: number;
  /** OB 下沿 */
  bottom: number;
  /** OB 中间价 */
  mid: number;
  /** 形成时间 */
  time: number;
  /** 索引 */
  index: number;
  /** 是否尚未被触及 */
  isActive: boolean;
  /** 强度评分 0-100 */
  strength: number;
  /** 描述 */
  desc: string;
}

/**
 * 识别订单块：
 * 看涨 OB = 强烈下跌走势前的最后一根阳线实体
 * 看跌 OB = 强烈上涨走势前的最后一根阴线实体
 */
export function detectOrderBlocks(klines: KlineData[], minImpulsePct: number = 1.5): OrderBlock[] {
  const obs: OrderBlock[] = [];
  if (klines.length < 10) return obs;

  // 找冲动走势：连续 3-5 根同向 K 线，总幅度 > minImpulsePct
  for (let i = 5; i < klines.length - 3; i++) {
    // 检查从 i 开始的下跌冲动
    let downImpulse = 0;
    let downCount = 0;
    let lastBullishIdx = -1;
    for (let j = i; j < Math.min(i + 5, klines.length); j++) {
      const k = klines[j];
      if (k.close < k.open) {
        downImpulse += (k.open - k.close) / k.open * 100;
        downCount++;
      } else {
        break;
      }
    }
    // 找到下跌前的最后一根阳线
    if (downCount >= 2 && downImpulse >= minImpulsePct) {
      for (let b = i - 1; b >= Math.max(0, i - 5); b--) {
        if (klines[b].close > klines[b].open) {
          lastBullishIdx = b;
          break;
        }
      }
      if (lastBullishIdx >= 0) {
        const obK = klines[lastBullishIdx];
        const top = Math.max(obK.open, obK.close);
        const bottom = Math.min(obK.open, obK.close);
        // 检查是否已被触及
        let isActive = true;
        for (let j = i + downCount; j < klines.length; j++) {
          if (klines[j].low <= top && klines[j].high >= bottom) {
            isActive = false;
            break;
          }
        }
        // 强度 = 冲动幅度 + 影线比例
        const wickRatio = (obK.high - obK.low) > 0
          ? Math.abs(obK.close - obK.open) / (obK.high - obK.low)
          : 0.5;
        const strength = Math.min(95, Math.round(40 + downImpulse * 15 + wickRatio * 30));
        obs.push({
          type: 'bullish',
          top, bottom,
          mid: (top + bottom) / 2,
          time: obK.time,
          index: lastBullishIdx,
          isActive,
          strength,
          desc: `下跌${downImpulse.toFixed(2)}%前阳线，强度${strength}`,
        });
      }
    }

    // 检查从 i 开始的上涨冲动
    let upImpulse = 0;
    let upCount = 0;
    let lastBearishIdx = -1;
    for (let j = i; j < Math.min(i + 5, klines.length); j++) {
      const k = klines[j];
      if (k.close > k.open) {
        upImpulse += (k.close - k.open) / k.open * 100;
        upCount++;
      } else {
        break;
      }
    }
    // 找到上涨前的最后一根阴线
    if (upCount >= 2 && upImpulse >= minImpulsePct) {
      for (let b = i - 1; b >= Math.max(0, i - 5); b--) {
        if (klines[b].close < klines[b].open) {
          lastBearishIdx = b;
          break;
        }
      }
      if (lastBearishIdx >= 0) {
        const obK = klines[lastBearishIdx];
        const top = Math.max(obK.open, obK.close);
        const bottom = Math.min(obK.open, obK.close);
        let isActive = true;
        for (let j = i + upCount; j < klines.length; j++) {
          if (klines[j].low <= top && klines[j].high >= bottom) {
            isActive = false;
            break;
          }
        }
        const wickRatio = (obK.high - obK.low) > 0
          ? Math.abs(obK.close - obK.open) / (obK.high - obK.low)
          : 0.5;
        const strength = Math.min(95, Math.round(40 + upImpulse * 15 + wickRatio * 30));
        obs.push({
          type: 'bearish',
          top, bottom,
          mid: (top + bottom) / 2,
          time: obK.time,
          index: lastBearishIdx,
          isActive,
          strength,
          desc: `上涨${upImpulse.toFixed(2)}%前阴线，强度${strength}`,
        });
      }
    }
  }

  // 去重：同一区域的 OB 只保留最强的
  const unique: OrderBlock[] = [];
  for (const ob of obs) {
    const dup = unique.find((u) => Math.abs(u.mid - ob.mid) / u.mid < 0.005 && u.type === ob.type);
    if (!dup) unique.push(ob);
    else if (ob.strength > dup.strength) {
      const idx = unique.indexOf(dup);
      unique[idx] = ob;
    }
  }

  return unique.filter((o) => o.isActive).sort((a, b) => b.strength - a.strength);
}

// ========== 流动性猎杀 (Liquidity Sweep) 检测 ==========

export interface LiquiditySweep {
  type: 'buySide' | 'sellSide';
  /** 被猎杀的流动性池价格 */
  liquidityPrice: number;
  /** 猎杀发生的 K 线索引 */
  sweepIndex: number;
  /** 猎杀时的最低价/最高价 */
  sweepExtreme: number;
  /** 收回后的收盘价 */
  reclaimClose: number;
  /** 是否有效（已收回） */
  isValid: boolean;
  /** 影线长度比例 */
  wickRatio: number;
  /** 描述 */
  desc: string;
}

/**
 * 检测流动性猎杀：
 * buySide = 突破前高后快速收回（猎杀多单止损）
 * sellSide = 跌破前低后快速收回（猎杀空单止损）
 */
export function detectLiquiditySweeps(
  klines: KlineData[],
  structure: MarketStructure | null,
): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  if (!structure || structure.swings.length < 4 || klines.length < 10) return sweeps;

  const { swings } = structure;

  // 检查每个 swing high（buy-side liquidity）
  const highs = swings.filter((s) => s.type === 'swingHigh');
  for (const h of highs) {
    const hIdx = h.index;
    if (hIdx >= klines.length - 3) continue;

    // 检查后续 1-3 根 K 线是否突破该高点
    for (let i = hIdx + 1; i <= Math.min(hIdx + 3, klines.length - 2); i++) {
      const k = klines[i];
      if (k.high > h.price) {
        // 突破了，检查是否收回（收盘价低于高点）
        if (k.close < h.price) {
          const wickRatio = (k.high - k.low) > 0 ? (k.high - Math.max(k.open, k.close)) / (k.high - k.low) : 0;
          if (wickRatio > 0.3) {
            sweeps.push({
              type: 'buySide',
              liquidityPrice: h.price,
              sweepIndex: i,
              sweepExtreme: k.high,
              reclaimClose: k.close,
              isValid: true,
              wickRatio: Math.round(wickRatio * 100) / 100,
              desc: `突破前高 $${h.price.toFixed(2)} 后收回，上影线${(wickRatio * 100).toFixed(0)}%，猎杀流动性`,
            });
            break;
          }
        }
        // 如果下一根收回也算
        const next = klines[i + 1];
        if (next && next.close < h.price && k.close < h.price) {
          const wickRatio = (k.high - k.low) > 0 ? (k.high - Math.max(k.open, k.close)) / (k.high - k.low) : 0;
          if (wickRatio > 0.2) {
            sweeps.push({
              type: 'buySide',
              liquidityPrice: h.price,
              sweepIndex: i,
              sweepExtreme: k.high,
              reclaimClose: next.close,
              isValid: true,
              wickRatio: Math.round(wickRatio * 100) / 100,
              desc: `突破前高后次根收回，猎杀流动性`,
            });
            break;
          }
        }
      }
    }
  }

  // 检查每个 swing low（sell-side liquidity）
  const lows = swings.filter((s) => s.type === 'swingLow');
  for (const l of lows) {
    const lIdx = l.index;
    if (lIdx >= klines.length - 3) continue;

    for (let i = lIdx + 1; i <= Math.min(lIdx + 3, klines.length - 2); i++) {
      const k = klines[i];
      if (k.low < l.price) {
        if (k.close > l.price) {
          const wickRatio = (k.high - k.low) > 0 ? (Math.min(k.open, k.close) - k.low) / (k.high - k.low) : 0;
          if (wickRatio > 0.3) {
            sweeps.push({
              type: 'sellSide',
              liquidityPrice: l.price,
              sweepIndex: i,
              sweepExtreme: k.low,
              reclaimClose: k.close,
              isValid: true,
              wickRatio: Math.round(wickRatio * 100) / 100,
              desc: `跌破前低 $${l.price.toFixed(2)} 后收回，下影线${(wickRatio * 100).toFixed(0)}%，猎杀流动性`,
            });
            break;
          }
        }
        const next = klines[i + 1];
        if (next && next.close > l.price && k.close > l.price) {
          const wickRatio = (k.high - k.low) > 0 ? (Math.min(k.open, k.close) - k.low) / (k.high - k.low) : 0;
          if (wickRatio > 0.2) {
            sweeps.push({
              type: 'sellSide',
              liquidityPrice: l.price,
              sweepIndex: i,
              sweepExtreme: k.low,
              reclaimClose: next.close,
              isValid: true,
              wickRatio: Math.round(wickRatio * 100) / 100,
              desc: `跌破前低后次根收回，猎杀流动性`,
            });
            break;
          }
        }
      }
    }
  }

  return sweeps.sort((a, b) => b.sweepIndex - a.sweepIndex);
}

// ========== 底分型 / 顶分型检测 ==========

export interface FractalPattern {
  type: '底分型' | '顶分型';
  /** 中间K线索引 */
  centerIdx: number;
  /** 中间K线时间 */
  time: number;
  /** 分型高低价 */
  high: number;
  low: number;
  /** 确认状态：formed=已形成，confirmed=右侧已确认，invalidated=已破坏 */
  status: 'formed' | 'confirmed' | 'invalidated';
  /** 信号强度 0-100 */
  strength: number;
  /** 描述 */
  desc: string;
}

/**
 * 底分型：连续3根K线，中间那根的低点最低（左K低 > 中K低 < 右K低）
 * 顶分型：连续3根K线，中间那根的高点最高（左K高 < 中K高 > 右K高）
 *
 * 增强规则：
 * - 底分型中间K线最好是阴线（先跌后涨的拐点）
 * - 顶分型中间K线最好是阳线（先涨后跌的拐点）
 * - 右侧K线收盘价要突破中间K线的实体，才算 confirmed
 */
export function detectFractalPatterns(klines: KlineData[], maxLookback: number = 60): FractalPattern[] {
  const patterns: FractalPattern[] = [];
  if (klines.length < 10) return patterns;

  const start = Math.max(2, klines.length - maxLookback);
  const len = klines.length;

  for (let i = start; i < len - 1; i++) {
    const left = klines[i - 1];
    const mid = klines[i];
    const right = klines[i + 1];

    // 底分型：中间K线低点最低
    if (mid.low < left.low && mid.low < right.low) {
      // 检查是否已破坏（后续K线跌破中间K线低点）
      let status: FractalPattern['status'] = 'formed';
      let invalidated = false;
      for (let j = i + 2; j < len; j++) {
        if (klines[j].low < mid.low) {
          invalidated = true;
          break;
        }
      }
      if (invalidated) status = 'invalidated';
      else if (i + 2 < len && right.close > mid.high) status = 'confirmed';
      else if (i + 3 < len && klines[i + 2].close > mid.high) status = 'confirmed';

      if (status !== 'invalidated') {
        // 强度：中间是阴线加分，下影线长加分，右K收盘突破实体加分
        let str = 30;
        if (mid.close < mid.open) str += 15; // 阴线底
        const lowerWick = Math.min(mid.open, mid.close) - mid.low;
        const body = Math.abs(mid.close - mid.open);
        if (body > 0 && lowerWick / body > 1.5) str += 15; // 长下影线
        if (status === 'confirmed') str += 20;
        // 左右K线实体较大 = 明显的转折
        const leftBody = Math.abs(left.close - left.open);
        const rightBody = Math.abs(right.close - right.open);
        if (leftBody > body * 0.5 && rightBody > body * 0.5) str += 10;

        str = Math.min(95, str);

        patterns.push({
          type: '底分型',
          centerIdx: i,
          time: mid.time,
          high: mid.high,
          low: mid.low,
          status,
          strength: str,
          desc: `底分型 $${mid.low.toFixed(2)}，${status === 'confirmed' ? '已确认' : '待确认'}，强度${str}`,
        });
      }
    }

    // 顶分型：中间K线高点最高
    if (mid.high > left.high && mid.high > right.high) {
      let status: FractalPattern['status'] = 'formed';
      let invalidated = false;
      for (let j = i + 2; j < len; j++) {
        if (klines[j].high > mid.high) {
          invalidated = true;
          break;
        }
      }
      if (invalidated) status = 'invalidated';
      else if (i + 2 < len && right.close < mid.low) status = 'confirmed';
      else if (i + 3 < len && klines[i + 2].close < mid.low) status = 'confirmed';

      if (status !== 'invalidated') {
        let str = 30;
        if (mid.close > mid.open) str += 15; // 阳线顶
        const upperWick = mid.high - Math.max(mid.open, mid.close);
        const body = Math.abs(mid.close - mid.open);
        if (body > 0 && upperWick / body > 1.5) str += 15; // 长上影线
        if (status === 'confirmed') str += 20;
        const leftBody = Math.abs(left.close - left.open);
        const rightBody = Math.abs(right.close - right.open);
        if (leftBody > body * 0.5 && rightBody > body * 0.5) str += 10;

        str = Math.min(95, str);

        patterns.push({
          type: '顶分型',
          centerIdx: i,
          time: mid.time,
          high: mid.high,
          low: mid.low,
          status,
          strength: str,
          desc: `顶分型 $${mid.high.toFixed(2)}，${status === 'confirmed' ? '已确认' : '待确认'}，强度${str}`,
        });
      }
    }
  }

  // 只返回有效的，最近的优先
  return patterns.filter((p) => p.status !== 'invalidated').sort((a, b) => b.centerIdx - a.centerIdx);
}

// ========== 资金管理 ==========

export interface PositionSizing {
  /** 建议仓位比例（占总资金%） */
  positionPct: number;
  /** 最大亏损金额（基于止损） */
  maxLossAmount: number;
  /** 每笔亏损占总资金比例 */
  lossPctOfTotal: number;
  /** 建议杠杆倍数 */
  leverage: number;
  /** 入场价格 */
  entryPrice: number;
  /** 止损价格 */
  stopLoss: number;
  /** ATR 值 */
  atr: number;
  /** 说明 */
  desc: string;
}

/**
 * 基于 ATR 的仓位管理
 * - 单笔最大亏损 = 总资金 × riskPct（默认 2%）
 * - 仓位大小 = 最大亏损 / (入场价 - 止损价)
 * - 杠杆 = 1 / 仓位占比（不超过 maxLeverage）
 */
export function calcPositionSizing(
  totalCapital: number,
  entryPrice: number,
  klines: KlineData[],
  direction: '做多' | '做空' | '观望',
  riskPct: number = 2,       // 单笔最大亏损占总资金比例
  maxLeverage: number = 10,   // 最大杠杆
  atrMultiplier: number = 1.5,
): PositionSizing | null {
  if (direction === '观望' || !klines || klines.length < 20) return null;

  const atr = calcATR(klines, 14);
  if (atr <= 0) return null;

  const sl = calcATRStopLoss(entryPrice, klines, direction, atrMultiplier);
  const riskPerTrade = totalCapital * (riskPct / 100);
  const stopDistance = Math.abs(entryPrice - sl);

  if (stopDistance <= 0) return null;

  const positionSize = riskPerTrade / stopDistance; // 合约张数/币数
  const positionValue = positionSize * entryPrice;  // 仓位价值
  const positionPct = (positionValue / totalCapital) * 100;
  const leverage = Math.min(maxLeverage, Math.max(1, Math.round(positionValue / totalCapital)));

  const actualLossPct = (stopDistance * positionSize / totalCapital) * 100;
  const actualLossAmount = stopDistance * positionSize;

  const dir = direction === '做多' ? '做多' : '做空';
  const desc = `${dir} ${entryPrice.toFixed(2)}，止损 ${sl.toFixed(2)}，ATR ${atr.toFixed(2)}，仓位${positionPct.toFixed(1)}%，${leverage}x杠杆，单笔亏${actualLossPct.toFixed(2)}%`;

  return {
    positionPct: Math.round(positionPct * 10) / 10,
    maxLossAmount: Math.round(actualLossAmount * 100) / 100,
    lossPctOfTotal: Math.round(actualLossPct * 100) / 100,
    leverage,
    entryPrice,
    stopLoss: sl,
    atr: Math.round(atr * 100) / 100,
    desc,
  };
}

// ========== 选币策略（多币种筛选） ==========

export interface CoinScreeningResult {
  symbol: string;
  okxId: string;
  score: number;
  reasons: string[];
  trend: '上升' | '下降' | '盘整';
  momentumScore: number;
  volumeRatio: number;
}

/**
 * 对多个币种进行筛选评分
 * 综合考虑：趋势方向、动量评分、量能变化、RSI位置
 */
export function screenCoins(
  coins: { symbol: string; okxId: string; klines: KlineData[] }[],
  currentPriceMap: Record<string, number>,
): CoinScreeningResult[] {
  const results: CoinScreeningResult[] = [];

  for (const coin of coins) {
    if (coin.klines.length < 50) continue;

    const klines = coin.klines;
    const currentPrice = currentPriceMap[coin.symbol] || klines[klines.length - 1].close;

    // 1. 趋势判断（MA20 方向）
    const closes20 = klines.slice(-20).map((k) => k.close);
    const ma20 = closes20.reduce((s, c) => s + c, 0) / 20;
    const ma5 = klines.slice(-5).map((k) => k.close).reduce((s, c) => s + c, 0) / 5;
    let trend: '上升' | '下降' | '盘整' = '盘整';
    if (ma5 > ma20 * 1.003) trend = '上升';
    else if (ma5 < ma20 * 0.997) trend = '下降';

    // 2. 动量评分
    const closes10 = klines.slice(-10).map((k) => k.close);
    const mom10 = ((closes10[closes10.length - 1] - closes10[0]) / closes10[0]) * 100;
    const momentumScore = Math.round(mom10 * 5);

    // 3. 量能
    const recentVol = klines.slice(-5).reduce((s, k) => s + k.volume, 0) / 5;
    const olderVol = klines.slice(-20, -5).reduce((s, k) => s + k.volume, 0) / 15;
    const volumeRatio = olderVol > 0 ? Math.round((recentVol / olderVol) * 100) / 100 : 1;

    // 4. RSI
    const rsi = calcRSI(klines, 14) || 50;

    // 5. 综合评分（0-100）
    let score = 50; // 基础分
    const reasons: string[] = [];

    // 趋势加分
    if (trend === '上升') { score += 15; reasons.push('MA5>MA20 上升趋势'); }
    else if (trend === '下降') { score -= 15; reasons.push('MA5<MA20 下降趋势'); }
    else { reasons.push('MA5≈MA20 震荡'); }

    // 动量加分
    if (momentumScore > 10) { score += 10; reasons.push(`动量+${momentumScore}偏多`); }
    else if (momentumScore < -10) { score -= 10; reasons.push(`动量${momentumScore}偏空`); }

    // 量能加分
    if (volumeRatio > 1.3) { score += 8; reasons.push(`放量${volumeRatio.toFixed(1)}x`); }
    else if (volumeRatio < 0.7) { score -= 5; reasons.push(`缩量${volumeRatio.toFixed(1)}x`); }

    // RSI
    if (rsi >= 40 && rsi <= 65) { score += 7; reasons.push(`RSI ${rsi} 健康区`); }
    else if (rsi >= 70) { score -= 8; reasons.push(`RSI ${rsi} 超买`); }
    else if (rsi <= 30) { score += 5; reasons.push(`RSI ${rsi} 超卖机会`); }

    // 价格在 MA20 上方
    if (currentPrice > ma20) { score += 5; reasons.push('价格在MA20上方'); }

    score = Math.max(0, Math.min(100, Math.round(score)));

    results.push({
      symbol: coin.symbol,
      okxId: coin.okxId,
      score,
      reasons,
      trend,
      momentumScore,
      volumeRatio,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

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

export interface BacktestResult {
  totalSignals: number;
  longSignals: number;
  shortSignals: number;
  longWins: number;
  shortWins: number;
  longWinRate: number;
  shortWinRate: number;
  totalWinRate: number;
  avgRR: number;
  maxConsecutiveLoss: number;
  recentSignals: {
    time: number;
    type: '做多' | '做空' | '减仓多' | '减仓空' | '平多' | '平空';
    entryPrice: number;
    result: 'win' | 'loss' | 'pending';
    pnl: number;
    desc: string;
  }[];
}

/**
 * 江恩1x1角度线（45度角）
 * 从AB9的A点（起点）出发，按1单位价格:1单位时间的速率延伸
 * 多头：角度线从低点向上延伸，价格跌破角度线 = 趋势减弱预警
 * 空头：角度线从高点向下延伸，价格突破角度线 = 趋势减弱预警
 */
export interface GannAngleResult {
  currentAnglePrice: number;
  pricePerBar: number;
  above: boolean;
  deviationPct: number;
  warning: boolean;
  description: string;
}

export function calcGannAngle(ab9: AB9Analysis, klines: KlineData[]): GannAngleResult | null {
  if (!ab9 || !klines || klines.length < 10) return null;

  // 在klines数组中找到 timeA 对应的索引（timeA是时间戳，不是数组索引）
  const startPrice = ab9.pointA;
  let startIndex = -1;
  for (let i = 0; i < klines.length; i++) {
    if (klines[i].time === ab9.timeA) { startIndex = i; break; }
  }
  // 找不到就取数组中间位置
  if (startIndex < 0) startIndex = Math.floor(klines.length * 0.3);

  const currentBarIndex = klines.length - 1 - startIndex;
  if (currentBarIndex <= 0) return null;

  const totalHeight = Math.abs(ab9.pointB - ab9.pointA);

  // 江恩1x1角度线：每根K线移动总高度的 1/8
  const increment = totalHeight / 8;

  const currentAnglePrice = ab9.direction === 'up'
    ? startPrice + increment * currentBarIndex
    : startPrice - increment * currentBarIndex;

  const currentPrice = klines[klines.length - 1].close;
  const above = currentPrice > currentAnglePrice;
  const deviation = ((currentPrice - currentAnglePrice) / currentAnglePrice) * 100;
  const warning = ab9.direction === 'up' ? !above : above;

  let description = '';
  if (ab9.direction === 'up') {
    if (above && deviation > 3) description = '价格在角度线上方，多头强劲';
    else if (above && deviation > 0) description = '价格略高于角度线，多头正常';
    else if (!above && deviation > -3) description = '价格贴近角度线下方，注意预警';
    else description = '价格跌破角度线，多头趋势减弱';
  } else {
    if (!above && deviation < -3) description = '价格在角度线下方，空头强劲';
    else if (!above && deviation < 0) description = '价格略低于角度线，空头正常';
    else if (above && deviation < 3) description = '价格贴近角度线上方，注意预警';
    else description = '价格突破角度线，空头趋势减弱';
  }

  return { currentAnglePrice, pricePerBar: increment, above, deviationPct: Math.round(deviation * 100) / 100, warning, description };
}

/**
 * 回测逻辑：
 * 1. 遍历历史K线，在每个时间点计算当时的 AB9 线和分型
 * 2. 当分型确认时，按策略规则模拟进场
 * 3. 持仓期间如果出现反向分型，模拟出场
 * 4. 统计胜率和盈亏比
 */
export function backtestAB9Fractal(klines: KlineData[], lookback: number = 200): BacktestResult {
  const result: BacktestResult = {
    totalSignals: 0,
    longSignals: 0,
    shortSignals: 0,
    longWins: 0,
    shortWins: 0,
    longWinRate: 0,
    shortWinRate: 0,
    totalWinRate: 0,
    avgRR: 0,
    maxConsecutiveLoss: 0,
    recentSignals: [],
  };

  if (klines.length < 60) return result;

  const start = Math.max(0, klines.length - lookback);
  const data = klines.slice(start);

  let position: null | { type: '做多' | '做空'; entryPrice: number; entryTime: number; stopLoss: number } = null;
  const trades: { type: '做多' | '做空'; entry: number; exit: number; pnl: number; time: number; result: 'win' | 'loss' }[] = [];
  let consecutiveLoss = 0;

  for (let i = 10; i < data.length - 2; i++) {
    const slice = data.slice(Math.max(0, i - 50), i + 1);
    if (slice.length < 30) continue;

    const ab9 = calcAB9Lines(slice);
    if (!ab9) continue;

    const line3 = ab9.lines[2].price;
    const line4 = ab9.lines[3].price;
    const line5 = ab9.lines[4].price;
    const atr = calcATR(slice, 14);
    if (atr <= 0) continue;

    const price = data[i].close;

    // 检测分型（只用已确认的）
    const left = data[i - 1];
    const mid = data[i];
    const right = i + 1 < data.length ? data[i + 1] : null;
    if (!right) continue;

    // 顶分型确认：mid.high > left.high && mid.high > right.high && right.close < mid.low
    if (mid.high > left.high && mid.high > right.high && right.close < mid.low) {
      if (ab9.direction === 'up') {
        // 上升趋势 + 顶分型 = 出场多单或做空信号
        if (position?.type === '做多') {
          const pnl = price - position.entryPrice;
          const pnlPct = (pnl / atr) * 100;
          trades.push({
            type: '做多', entry: position.entryPrice, exit: price,
            pnl: Math.round(pnlPct * 10) / 10,
            time: mid.time, result: pnl >= 0 ? 'win' : 'loss',
          });
          consecutiveLoss = pnl < 0 ? consecutiveLoss + 1 : 0;
          position = null;
        }

        // 如果在4线下方，开空
        if (!position && mid.high < line4) {
          position = { type: '做空', entryPrice: price, entryTime: mid.time, stopLoss: line3 + atr };
        }
      }
    }

    // 底分型确认：mid.low < left.low && mid.low < right.low && right.close > mid.high
    if (mid.low < left.low && mid.low < right.low && right.close > mid.high) {
      if (ab9.direction === 'down') {
        // 下降趋势 + 底分型 = 出场空单或做多信号
        if (position?.type === '做空') {
          const pnl = position.entryPrice - price;
          const pnlPct = (pnl / atr) * 100;
          trades.push({
            type: '做空', entry: position.entryPrice, exit: price,
            pnl: Math.round(pnlPct * 10) / 10,
            time: mid.time, result: pnl >= 0 ? 'win' : 'loss',
          });
          consecutiveLoss = pnl < 0 ? consecutiveLoss + 1 : 0;
          position = null;
        }

        // 如果在4线上方，开多
        if (!position && mid.low > line4) {
          position = { type: '做多', entryPrice: price, entryTime: mid.time, stopLoss: line3 - atr };
        }
      }
    }

    // 止损出场
    if (position) {
      if (position.type === '做多' && price < position.stopLoss) {
        const pnl = price - position.entryPrice;
        const pnlPct = (pnl / atr) * 100;
        trades.push({ type: '做多', entry: position.entryPrice, exit: price, pnl: Math.round(pnlPct * 10) / 10, time: mid.time, result: 'loss' });
        consecutiveLoss++;
        position = null;
      } else if (position.type === '做空' && price > position.stopLoss) {
        const pnl = position.entryPrice - price;
        const pnlPct = (pnl / atr) * 100;
        trades.push({ type: '做空', entry: position.entryPrice, exit: price, pnl: Math.round(pnlPct * 10) / 10, time: mid.time, result: 'loss' });
        consecutiveLoss++;
        position = null;
      }
    }
  }

  // 如果最后还有持仓，按最新价平仓
  if (position && data.length > 0) {
    const lastPrice = data[data.length - 1].close;
    const pnl = position.type === '做多' ? lastPrice - position.entryPrice : position.entryPrice - lastPrice;
    const finalAtr = calcATR(data, 14);
    const pnlPct = finalAtr > 0 ? (pnl / finalAtr) * 100 : pnl;
    trades.push({ type: position.type, entry: position.entryPrice, exit: lastPrice, pnl: Math.round(pnlPct * 10) / 10, time: data[data.length - 1].time, result: pnl >= 0 ? 'win' : 'loss' });
  }

  // 统计
  const longTrades = trades.filter((t) => t.type === '做多');
  const shortTrades = trades.filter((t) => t.type === '做空');
  result.totalSignals = trades.length;
  result.longSignals = longTrades.length;
  result.shortSignals = shortTrades.length;
  result.longWins = longTrades.filter((t) => t.result === 'win').length;
  result.shortWins = shortTrades.filter((t) => t.result === 'win').length;
  result.longWinRate = longTrades.length > 0 ? Math.round((result.longWins / longTrades.length) * 1000) / 10 : 0;
  result.shortWinRate = shortTrades.length > 0 ? Math.round((result.shortWins / shortTrades.length) * 1000) / 10 : 0;
  result.totalWinRate = trades.length > 0 ? Math.round(((result.longWins + result.shortWins) / trades.length) * 1000) / 10 : 0;

  // 盈亏比
  const wins = trades.filter((t) => t.result === 'win');
  const losses = trades.filter((t) => t.result === 'loss');
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  result.avgRR = avgLoss > 0 ? Math.round((avgWin / avgLoss) * 100) / 100 : 0;
  result.maxConsecutiveLoss = consecutiveLoss;

  // 最近5条信号
  result.recentSignals = trades.slice(-5).reverse().map((t) => ({
    time: t.time,
    type: t.type,
    entryPrice: t.entry,
    result: t.result,
    pnl: t.pnl,
    desc: `${t.type} @ $${t.entry.toFixed(0)} → ${t.result === 'win' ? '+' : ''}${t.pnl}%`,
  }));

  return result;
}