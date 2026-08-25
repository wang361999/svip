/**
 * 趋势回调策略（Trend Pullback）— 纯规则引擎，无 LLM 依赖
 *
 * 三层结构（与回测 backtest-final 完全一致，参数冻结）：
 *   1. 环境层：1h EMA150 上/下 ±0.3% 缠绕区外才算趋势环境，
 *      且 10 根 EMA 斜率 ≥ 0.3% 同向（滤掉走平的假趋势）
 *   2. 回调层：趋势环境内连续 ≥2 根逆向K线（多头数阴线/空头数阳线），
 *      12 根内未触发则回调过期重置
 *   3. 触发层：1h 三根K线分型 + 突破确认（收盘上穿双高=多 / 下穿双低=空）
 *      → 限价挂单：进场=确认收盘 ∓0.2%，止损=分型极值 ±0.3%缓冲，目标=+2R
 *
 * 回测结论（2 年 1h·maker 0.02%·含止损缓冲）：
 *   BTC：24 单 · 胜率 41.7% · 期望 +0.212R/单 · PF 1.35 · 最大回撤 7.2R
 *   ETH：47 单 · 胜率 38.3% · 期望 +0.116R/单 · PF 1.18 · 最大回撤 11.6R
 *   两币种近一年分段均为正（+0.46R/单），EMA150 是唯一双币皆正的周期选择。
 */
import type { KlineData } from './market-data';

// ==================== 参数（冻结，来自回测网格） ====================

export interface TrendPullbackParams {
  emaPeriod: number;          // EMA 周期：150
  chopPct: number;            // EMA 缠绕区半宽：0.3%
  slopeN: number;             // 斜率回看根数
  slopeMin: number;           // 斜率门槛：0.3%
  pullbackMinBars: number;    // 回调最少逆向K线数
  pullbackExpiryBars: number; // 回调过期根数
  limitEntryPct: number;      // 限价回踩深度：0.2%
  stopBufferPct: number;      // 止损缓冲：0.3%
  tpR: number;                // 止盈倍数：2R（全仓，无部分止盈）
  maxRiskPct: number;         // 风险距离上限：3%
  orderValidBars: number;     // 挂单有效期：5 根 1h
}

export const DEFAULT_TP_PARAMS: TrendPullbackParams = {
  emaPeriod: 150,
  chopPct: 0.003,
  slopeN: 10,
  slopeMin: 0.003,
  pullbackMinBars: 2,
  pullbackExpiryBars: 12,
  limitEntryPct: 0.002,
  stopBufferPct: 0.003,
  tpR: 2,
  maxRiskPct: 0.03,
  orderValidBars: 5,
};

/** 策略版本号（写入分析记录 model 字段，便于战绩按版本归因） */
export const STRATEGY_ID = 'trend-pullback-1h-v1';

// ==================== 结果类型 ====================

export type StrategyStatus =
  | 'pending'   // 挂单中：已给进场价，等回踩成交
  | 'filled'    // 已成交：价格已触及挂单价，持仓等待离场
  | 'closed'    // 已了结：成交后止损/止盈已触发
  | 'waiting';  // 观望：不满足条件（附原因）

export interface TrendPullbackState {
  status: StrategyStatus;
  direction: 'long' | 'short';
  /** 趋势环境：1=多头 -1=空头 0=缠绕/未就绪 */
  trend: 1 | -1 | 0;
  trendLabel: string;
  /** EMA 状态（未就绪为 null） */
  ema: { value: number; distPct: number; slopePct: number } | null;
  /** 回调状态机 */
  pullback: { dir: number; bars: number; bornIdx: number };
  /** 触发分型（pending/filled/closed 时有值） */
  trigger: {
    /** 分型中间K线（极值K线）信息 */
    fractalPrice: number;
    fractalTime: number;
    /** 确认K线（收盘突破那根） */
    confirmTime: number;
    confirmClose: number;
    barsAgo: number;
  } | null;
  /** 挂单（pending/filled/closed 时有值） */
  order: {
    entry: number;
    stop: number;
    tp: number;      // 主止盈 2R
    tp1: number;     // 1R 参考位（可选减仓位，回测主口径为 2R 全出）
    risk: number;
    riskPct: number;
    expiresAt: number; // 挂单失效时间戳（ms）
  } | null;
  /** closed 时的了结结果 */
  outcome: 'stop' | 'tp' | null;
  /** waiting 时的原因（其余状态为空串） */
  waitingReason: string;
  /** 规则链解释（reasoning 用，逐条） */
  chain: string[];
  /** 1h 数据不足（EMA 未就绪） */
  insufficientData: boolean;
}

// ==================== EMA ====================

function emaSeries(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += closes[j];
      prev = s / period;
    } else {
      prev = closes[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

// ==================== 主分析 ====================

const HOUR_MS = 3_600_000;

/**
 * 分析趋势回调策略状态（只用已收盘的 1h K线）
 * @param k1hRaw 原始 1h K线（可含未走完的当前K线，内部自动剔除）
 */
export function analyzeTrendPullback(k1hRaw: KlineData[]): TrendPullbackState {
  const p = DEFAULT_TP_PARAMS;

  const empty: TrendPullbackState = {
    status: 'waiting', direction: 'long', trend: 0, trendLabel: '未就绪',
    ema: null, pullback: { dir: 0, bars: 0, bornIdx: -1 }, trigger: null, order: null,
    outcome: null, waitingReason: '', chain: [], insufficientData: true,
  };

  // 0. 剔除未走完的当前K线（openTime + 1h > now → 未收盘）
  const now = Date.now();
  const bars = k1hRaw.filter((k) => k.time + HOUR_MS <= now);
  const n = bars.length;

  // 数据量门槛：EMA 预热 + 斜率回看 + 分型三根
  const minBars = p.emaPeriod + p.slopeN + 3;
  if (n < minBars) {
    return {
      ...empty,
      waitingReason: `1h 数据不足（${n}/${minBars} 根），EMA${p.emaPeriod} 未就绪`,
      chain: [`数据不足：${n} 根 1h，需要 ≥${minBars} 根（EMA${p.emaPeriod} 预热 + 斜率 ${p.slopeN} 根 + 分型 3 根）`],
    };
  }

  const closes = bars.map((k) => k.close);
  const ema = emaSeries(closes, p.emaPeriod);

  // 1. 逐根走状态机（与回测同款）：趋势环境 + 回调计数
  let trend: 1 | -1 | 0 = 0;
  let pullback = { dir: 0, bars: 0, bornIdx: -1 };
  // 每根K线收盘时「有效回调方向」（≥2 根逆向且与环境同向）
  const validPullDirAt: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const e = ema[i];
    if (e == null) continue;
    const c = closes[i];
    trend = c > e * (1 + p.chopPct) ? 1 : c < e * (1 - p.chopPct) ? -1 : 0;
    // 斜率过滤：走平的 EMA 不算趋势
    if (i >= p.slopeN && ema[i - p.slopeN] != null) {
      const slope = (ema[i]! - ema[i - p.slopeN]!) / ema[i - p.slopeN]!;
      if (trend === 1 && slope < p.slopeMin) trend = 0;
      if (trend === -1 && slope > -p.slopeMin) trend = 0;
    }
    // 回调状态机
    if (trend === 1) {
      const red = c < bars[i].open;
      if (red) {
        if (pullback.dir === 1) pullback.bars++;
        else pullback = { dir: 1, bars: 1, bornIdx: i };
      } else if (pullback.dir === 1 && c > closes[i - 1]) {
        pullback.bars = 0; // 收复失地，回调计数清零
      }
    } else if (trend === -1) {
      const green = c > bars[i].open;
      if (green) {
        if (pullback.dir === -1) pullback.bars++;
        else pullback = { dir: -1, bars: 1, bornIdx: i };
      } else if (pullback.dir === -1 && c < closes[i - 1]) {
        pullback.bars = 0;
      }
    } else {
      pullback = { dir: 0, bars: 0, bornIdx: -1 };
    }
    // 回调过期
    if (pullback.dir !== 0 && i - pullback.bornIdx > p.pullbackExpiryBars) {
      pullback = { dir: 0, bars: 0, bornIdx: -1 };
    }
    validPullDirAt[i] =
      pullback.dir !== 0 && pullback.bars >= p.pullbackMinBars && trend === pullback.dir
        ? pullback.dir
        : 0;
  }

  // 当前环境快照（最后一根收盘K线）
  const lastIdx = n - 1;
  const lastEma = ema[lastIdx]!;
  const lastClose = closes[lastIdx];
  const slopePct =
    ema[lastIdx - p.slopeN] != null
      ? (lastEma - ema[lastIdx - p.slopeN]!) / ema[lastIdx - p.slopeN]!
      : 0;
  const emaInfo = {
    value: lastEma,
    distPct: (lastClose - lastEma) / lastEma,
    slopePct,
  };
  const trendLabel = trend === 1 ? '多头环境' : trend === -1 ? '空头环境' : '缠绕/无趋势';

  const chain: string[] = [
    `环境：EMA${p.emaPeriod} ${lastEma.toFixed(lastEma >= 100 ? 2 : 4)} · 价格偏离 ${(emaInfo.distPct * 100).toFixed(2)}% · ${p.slopeN}根斜率 ${(slopePct * 100).toFixed(2)}% → ${trendLabel}`,
  ];

  // 2. 从最近的K线往回扫，找最近一次「分型+突破确认」触发
  //    扫描深度 = 挂单窗口 + 24 根：未成交挂单 5 根过期，已成交仓位可继续跟踪至离场（2R 常需数根以上）
  const scanDepth = p.orderValidBars + 24;
  let triggerIdx = -1;
  let trigDir: 1 | -1 = 1;
  let trigOrder: TrendPullbackState['order'] = null;
  let trigFractal: TrendPullbackState['trigger'] = null;

  for (let s = lastIdx; s >= Math.max(2, lastIdx - scanDepth) && s >= 2; s--) {
    const pd = validPullDirAt[s - 1];
    if (pd === 0) continue;
    const a = bars[s - 2], b = bars[s - 1], c = bars[s];
    // 多头：底分型（b 低点最低）+ 确认K线收盘上穿 a/b 双高
    if (pd === 1 && b.low < a.low && b.low < c.low && c.close > a.high && c.close > b.high) {
      const entry = c.close * (1 - p.limitEntryPct);
      const stop = b.low * (1 - p.stopBufferPct);
      const risk = entry - stop;
      if (risk > 0 && risk / entry <= p.maxRiskPct) {
        trigDir = 1; triggerIdx = s;
        trigOrder = {
          entry, stop,
          tp: entry + risk * p.tpR,
          tp1: entry + risk,
          risk, riskPct: risk / entry,
          expiresAt: bars[s].time + HOUR_MS * (p.orderValidBars + 1),
        };
        trigFractal = { fractalPrice: b.low, fractalTime: b.time, confirmTime: c.time, confirmClose: c.close, barsAgo: lastIdx - s };
        break;
      }
    }
    // 空头：顶分型 + 确认K线收盘下穿 a/b 双低
    if (pd === -1 && b.high > a.high && b.high > c.high && c.close < a.low && c.close < b.low) {
      const entry = c.close * (1 + p.limitEntryPct);
      const stop = b.high * (1 + p.stopBufferPct);
      const risk = stop - entry;
      if (risk > 0 && risk / entry <= p.maxRiskPct) {
        trigDir = -1; triggerIdx = s;
        trigOrder = {
          entry, stop,
          tp: entry - risk * p.tpR,
          tp1: entry - risk,
          risk, riskPct: risk / entry,
          expiresAt: bars[s].time + HOUR_MS * (p.orderValidBars + 1),
        };
        trigFractal = { fractalPrice: b.high, fractalTime: b.time, confirmTime: c.time, confirmClose: c.close, barsAgo: lastIdx - s };
        break;
      }
    }
  }

  const base = {
    trend, trendLabel, ema: emaInfo, pullback: { ...pullback },
    insufficientData: false, chain,
  };

  // 3. 无触发 → 观望，给出精确原因
  if (triggerIdx < 0 || !trigOrder || !trigFractal) {
    let reason: string;
    if (trend === 0) {
      reason = Math.abs(emaInfo.distPct) <= p.chopPct
        ? `价格贴 EMA${p.emaPeriod} 缠绕（±${p.chopPct * 100}%）→ 不做`
        : `EMA${p.emaPeriod} 斜率不足（${p.slopeN}根 ${(slopePct * 100).toFixed(2)}% < ${p.slopeMin * 100}%）→ 趋势未确立`;
      chain.push(reason);
    } else if (pullback.dir !== trend && pullback.dir === 0) {
      reason = `${trendLabel}无回调（等连续 ≥${p.pullbackMinBars} 根逆向K线）`;
      chain.push(reason);
    } else if (pullback.dir === trend && pullback.bars < p.pullbackMinBars) {
      reason = `${trendLabel}回调中（${pullback.bars}/${p.pullbackMinBars} 根逆向K线）· 等回调成形`;
      chain.push(reason);
    } else if (pullback.dir === trend && pullback.bars >= p.pullbackMinBars) {
      reason = `回调已成（${pullback.bars} 根逆向K线）· 等待 1h 分型 + 突破确认K线`;
      chain.push(reason);
    } else {
      reason = `${trendLabel} · 回调过期或被收复，等待新回调`;
      chain.push(reason);
    }
    return { ...base, status: 'waiting', direction: 'long', trigger: null, order: null, outcome: null, waitingReason: reason };
  }

  // 有触发 → 判定挂单生命周期（成交 / 了结 / 过期 / 挂单中）
  const dirName = trigDir === 1 ? '多' : '空';
  chain.push(
    `触发：${trigDir === 1 ? '底' : '顶'}分型 ${trigFractal.fractalPrice.toFixed(trigOrder.entry >= 100 ? 2 : 4)} + 确认K线收盘 ${trigFractal.confirmClose.toFixed(trigOrder.entry >= 100 ? 2 : 4)} ${trigDir === 1 ? '上穿双高' : '下穿双低'}（${trigFractal.barsAgo} 根前）`,
  );
  chain.push(
    `挂单：${trigOrder.entry.toFixed(trigOrder.entry >= 100 ? 2 : 4)}（${trigDir === 1 ? '低' : '高'}挂 ${(p.limitEntryPct * 100).toFixed(1)}%）· 止损 ${trigOrder.stop.toFixed(trigOrder.entry >= 100 ? 2 : 4)}（分型${trigDir === 1 ? '低' : '高'}点 ±${(p.stopBufferPct * 100).toFixed(1)}%，风险 ${(trigOrder.riskPct * 100).toFixed(2)}%）· 目标 ${trigOrder.tp.toFixed(trigOrder.entry >= 100 ? 2 : 4)}（+${p.tpR}R）· 有效 ${p.orderValidBars} 根 1h`,
  );

  const filledInfo = { direction: (trigDir === 1 ? 'long' : 'short') as 'long' | 'short', order: trigOrder, trigger: trigFractal };

  // 3a. 扫触发后的K线：是否成交 → 成交后是否止损/止盈
  //     （先判成交再判过期：已成交的仓位不受挂单窗口限制，窗口只约束未成交挂单）
  const barsSince = lastIdx - triggerIdx;
  let filled = false;
  let outcome: 'stop' | 'tp' | null = null;
  for (let i = triggerIdx + 1; i <= lastIdx; i++) {
    const bar = bars[i];
    if (!filled) {
      filled = trigDir === 1 ? bar.low <= trigOrder!.entry : bar.high >= trigOrder!.entry;
      continue; // 成交当根按挂单价进场，同根不算离场（与回测口径一致：进场后次根起判离场）
    }
    if (trigDir === 1) {
      if (bar.low <= trigOrder!.stop) { outcome = 'stop'; break; }
      if (bar.high >= trigOrder!.tp) { outcome = 'tp'; break; }
    } else {
      if (bar.high >= trigOrder!.stop) { outcome = 'stop'; break; }
      if (bar.low <= trigOrder!.tp) { outcome = 'tp'; break; }
    }
  }

  // 3b. 未成交且挂单窗口已过 → 过期
  if (!filled && barsSince > p.orderValidBars) {
    chain.push(`结果：${barsSince} 根未回踩到挂单价 → 挂单过期，等待下一次回调`);
    return { ...base, ...filledInfo, status: 'waiting', direction: filledInfo.direction, outcome: null, waitingReason: `上一${dirName}头挂单已过期（未回踩），等待新信号` };
  }

  if (!filled) {
    chain.push(`状态：挂单中 · 等价格回踩 ${trigOrder.entry.toFixed(trigOrder.entry >= 100 ? 2 : 4)}`);
    return { ...base, ...filledInfo, status: 'pending', outcome: null, waitingReason: '' };
  }
  if (outcome === 'tp') {
    chain.push(`状态：已成交 → 止盈 +${p.tpR}R 达成`);
    return { ...base, ...filledInfo, status: 'closed', outcome: 'tp', waitingReason: '' };
  }
  if (outcome === 'stop') {
    chain.push('状态：已成交 → 止损离场，等待新回调');
    return { ...base, ...filledInfo, status: 'closed', outcome: 'stop', waitingReason: '' };
  }
  chain.push(`状态：已成交持仓中 · 损 ${trigOrder.stop.toFixed(trigOrder.entry >= 100 ? 2 : 4)} · 盈 ${trigOrder.tp.toFixed(trigOrder.entry >= 100 ? 2 : 4)}`);
  return { ...base, ...filledInfo, status: 'filled', outcome: null, waitingReason: '' };
}

// ==================== 展示辅助 ====================

/** 格式化价格（>=100 保留2位小数，否则4位） */
export function fmtPrice(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 });
}

/** 状态中文 */
export function statusLabel(s: StrategyStatus): string {
  return s === 'pending' ? '挂单中' : s === 'filled' ? '持仓中' : s === 'closed' ? '已了结' : '观望';
}
