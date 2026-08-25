/**
 * 快进快出策略（EMA 价值区回踩收复）— 纯规则引擎，无 LLM 依赖
 *
 * 规则（与回测 fast-scalp-v2/v3/v4 完全一致，参数冻结）：
 *   1. 环境：15m EMA40 在 EMA200 上方 → 只做多；在下方 → 只做空
 *   2. 触发：前一根K线最低点踩到 EMA200 价值区（±0.1%），
 *      当前K线收回 EMA200 上方且收阳（空头镜像）→ 立即进场
 *   3. 执行：近市价限价（回踩 0.05%，视同即时成交），止损 0.8%，止盈 1.5R
 *   4. 快出：16 根 15m（4 小时）未到止盈 → 市价离场，不恋战
 *
 * 回测结论（2 年 15m · BTC+ETH · maker 进出/taker 止损）：
 *   798 单 · 日均 1.1 单 · 胜率 46.5% · 期望 +0.052R/单 · 月均 +1.73R
 *   邻域 27 组参数 22 组为正（81%）· 四个年度切片全正 · 多空两边都正
 *   ⚠ 全 taker 费率下期望归零 — 只能挂限价单执行
 */
import type { KlineData } from './market-data';

// ==================== 参数（冻结，来自回测网格） ====================

export interface EmaReclaimParams {
  emaFast: number;       // 快线（趋势判定）：40
  emaVal: number;        // 价值区（回踩锚）：200
  touchPct: number;      // 触线容差：0.1%
  limitPct: number;      // 限价回踩：0.05%（视同即时成交）
  stopPct: number;       // 止损距离：0.8%（约 2.6 倍 15m 波幅）
  tpR: number;           // 止盈倍数：1.5R
  timeStopBars: number;  // 时间止损：16 根 15m = 4 小时
}

export const DEFAULT_ER_PARAMS: EmaReclaimParams = {
  emaFast: 40,
  emaVal: 200,
  touchPct: 0.001,
  limitPct: 0.0005,
  stopPct: 0.008,
  tpR: 1.5,
  timeStopBars: 16,
};

/** 策略版本号（写入分析记录 model 字段，战绩按版本归因） */
export const STRATEGY_ID_FAST = 'ema-reclaim-15m-v1';

// ==================== 结果类型 ====================

export type FastStatus = 'pending' | 'filled' | 'closed' | 'waiting';

export interface EmaReclaimState {
  status: FastStatus;
  direction: 'long' | 'short';
  /** 环境：1=多头（快线在价值区上）-1=空头 0=未就绪 */
  env: 1 | -1 | 0;
  envLabel: string;
  /** 双 EMA 快照（未就绪为 null） */
  ema: { fast: number; val: number; distPct: number } | null;
  /** 最近信号（pending/filled/closed 时有值） */
  signal: {
    time: number;        // 信号K线（当前确认K线）开盘时间
    close: number;       // 确认K线收盘价
    barsAgo: number;     // 距最新已收盘K线的根数
  } | null;
  /** 交易单（pending/filled/closed 时有值） */
  order: {
    entry: number;
    stop: number;
    tp: number;          // 1.5R
    risk: number;
    riskPct: number;
    /** 时间止损截止时间戳（ms） */
    timeStopAt: number;
  } | null;
  /** closed 时的了结结果 */
  outcome: 'stop' | 'tp' | 'time' | null;
  /** waiting 时的原因 */
  waitingReason: string;
  /** 规则链解释 */
  chain: string[];
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

const FIFTEEN_MS = 15 * 60 * 1000;

/**
 * 分析快引擎状态（只用已收盘的 15m K线）
 * @param k15mRaw 原始 15m K线（可含未走完的当前K线，内部自动剔除）
 */
export function analyzeEmaReclaim(k15mRaw: KlineData[]): EmaReclaimState {
  const p = DEFAULT_ER_PARAMS;

  const empty: EmaReclaimState = {
    status: 'waiting', direction: 'long', env: 0, envLabel: '未就绪',
    ema: null, signal: null, order: null, outcome: null,
    waitingReason: '', chain: [], insufficientData: true,
  };

  // 0. 剔除未走完的当前K线（openTime + 15m > now → 未收盘）
  const now = Date.now();
  const bars = k15mRaw.filter((k) => k.time + FIFTEEN_MS <= now);
  const n = bars.length;

  // 数据量门槛：EMA200 预热 + 信号回看一根
  const minBars = p.emaVal + 2;
  if (n < minBars) {
    return {
      ...empty,
      waitingReason: `15m 数据不足（${n}/${minBars} 根），EMA${p.emaVal} 未就绪`,
      chain: [`数据不足：${n} 根 15m，需要 ≥${minBars} 根（EMA${p.emaVal} 预热 + 2 根）`],
    };
  }

  const closes = bars.map((k) => k.close);
  const emaF = emaSeries(closes, p.emaFast);
  const emaV = emaSeries(closes, p.emaVal);

  const lastIdx = n - 1;
  const envSnapshot = (i: number): 1 | -1 | 0 => {
    const f = emaF[i], v = emaV[i];
    if (f == null || v == null) return 0;
    return f > v ? 1 : -1;
  };
  const env = envSnapshot(lastIdx);
  const fL = emaF[lastIdx]!, vL = emaV[lastIdx]!;
  const lastClose = closes[lastIdx];
  const emaInfo = { fast: fL, val: vL, distPct: (lastClose - vL) / vL };
  const envLabel = env === 1 ? '多头环境（快线在价值区上）' : env === -1 ? '空头环境（快线在价值区下）' : '未就绪';

  const chain: string[] = [
    `环境：EMA${p.emaFast} ${fL.toFixed(fL >= 100 ? 2 : 4)} / EMA${p.emaVal} ${vL.toFixed(vL >= 100 ? 2 : 4)} · 收盘距价值区 ${(emaInfo.distPct * 100).toFixed(2)}% → ${envLabel}`,
  ];

  // 1. 从最新已收盘K线往回扫，找最近一次「踩线收回」信号
  //    扫描深度 = 时间止损 16 根 + 余量 4 根：信号生命周期内可继续跟踪至离场
  const scanDepth = p.timeStopBars + 4;
  let sigIdx = -1;
  let sigDir: 1 | -1 = 1;

  for (let s = lastIdx; s >= 1 && s >= lastIdx - scanDepth; s--) {
    const ef = emaF[s - 1], ev = emaV[s - 1];
    if (ef == null || ev == null) continue;
    const prev = bars[s - 1], cur = bars[s];
    // 多头：快线在价值区上 · 前收盘在快线上 · 前低踩到价值区 · 当前收回价值区且收阳
    if (ef > ev && prev.close > ef && prev.low <= ev * (1 + p.touchPct) && cur.close > ev && cur.close > cur.open) {
      sigDir = 1; sigIdx = s; break;
    }
    // 空头镜像
    if (ef < ev && prev.close < ef && prev.high >= ev * (1 - p.touchPct) && cur.close < ev && cur.close < cur.open) {
      sigDir = -1; sigIdx = s; break;
    }
  }

  const base = { env, envLabel, ema: emaInfo, insufficientData: false, chain };

  // 2. 无信号 → 观望，给出精确原因（当前卡在哪一步）
  if (sigIdx < 0) {
    const prev = bars[lastIdx - 1], cur = bars[lastIdx];
    let reason: string;
    if (env === 1) {
      if (cur.close < vL) reason = '价格跌回价值区下方 → 等收回 EMA200 之上的收复K线';
      else if (prev.low <= vL * (1 + p.touchPct) && !(cur.close > cur.open && cur.close > vL)) reason = '已踩到价值区 · 等收复阳线确认';
      else reason = `${envLabel} · 等价格回踩 EMA${p.emaVal} 价值区（±${(p.touchPct * 100).toFixed(1)}%）`;
    } else if (env === -1) {
      if (cur.close > vL) reason = '价格弹回价值区上方 → 等跌回 EMA200 之下的收复阴线';
      else if (prev.high >= vL * (1 - p.touchPct) && !(cur.close < cur.open && cur.close < vL)) reason = '已反抽到价值区 · 等收复阴线确认';
      else reason = `${envLabel} · 等价格反抽 EMA${p.emaVal} 价值区（±${(p.touchPct * 100).toFixed(1)}%）`;
    } else {
      reason = 'EMA 未就绪';
    }
    chain.push(reason);
    return { ...base, status: 'waiting', direction: 'long', signal: null, order: null, outcome: null, waitingReason: reason };
  }

  // 3. 有信号 → 构造交易单（限价视同即时成交 — 与回测同口径）
  const sigClose = bars[sigIdx].close;
  const entry = sigClose * (sigDir === 1 ? 1 - p.limitPct : 1 + p.limitPct);
  const risk = entry * p.stopPct;
  const stop = sigDir === 1 ? entry - risk : entry + risk;
  const tp = sigDir === 1 ? entry + risk * p.tpR : entry - risk * p.tpR;
  const order = {
    entry, stop, tp, risk, riskPct: p.stopPct,
    timeStopAt: bars[sigIdx].time + FIFTEEN_MS * (p.timeStopBars + 1),
  };
  const signal = { time: bars[sigIdx].time, close: sigClose, barsAgo: lastIdx - sigIdx };

  chain.push(
    `触发：${sigDir === 1 ? '回踩价值区后收复阳线' : '反抽价值区后收复阴线'} @ ${sigClose.toFixed(sigClose >= 100 ? 2 : 4)}（${signal.barsAgo} 根前）`,
  );
  chain.push(
    `挂单：${entry.toFixed(entry >= 100 ? 2 : 4)}（${sigDir === 1 ? '低' : '高'}挂 ${(p.limitPct * 100).toFixed(2)}%）· 止损 ${stop.toFixed(entry >= 100 ? 2 : 4)}（-${(p.stopPct * 100).toFixed(1)}%）· 目标 ${tp.toFixed(entry >= 100 ? 2 : 4)}（+${p.tpR}R）· ${p.timeStopBars * 0.25}h 未到止盈即离场`,
  );

  const dirName = sigDir === 1 ? 'long' : 'short';

  // 3a. 扫信号后的K线：止损 / 止盈 / 时间止损（先到先出）
  let outcome: 'stop' | 'tp' | 'time' | null = null;
  for (let i = sigIdx + 1; i <= lastIdx; i++) {
    const bar = bars[i];
    if (sigDir === 1) {
      if (bar.low <= stop) { outcome = 'stop'; break; }
      if (bar.high >= tp) { outcome = 'tp'; break; }
    } else {
      if (bar.high >= stop) { outcome = 'stop'; break; }
      if (bar.low <= tp) { outcome = 'tp'; break; }
    }
    if (i - sigIdx >= p.timeStopBars) { outcome = 'time'; break; }
  }

  // 3b. 生命周期：信号当根=挂单成交中（pending）· 次根起=持仓/已了结
  if (outcome === 'tp') {
    chain.push(`状态：已成交 → 止盈 +${p.tpR}R 达成`);
    return { ...base, status: 'closed', direction: dirName, signal, order, outcome: 'tp', waitingReason: '' };
  }
  if (outcome === 'stop') {
    chain.push('状态：已成交 → 止损离场（连亏为策略正常现象，勿停用）');
    return { ...base, status: 'closed', direction: dirName, signal, order, outcome: 'stop', waitingReason: '' };
  }
  if (outcome === 'time') {
    chain.push(`状态：已成交 → ${p.timeStopBars * 0.25}h 时间止损离场（快进快出，不恋战）`);
    return { ...base, status: 'closed', direction: dirName, signal, order, outcome: 'time', waitingReason: '' };
  }
  if (signal.barsAgo === 0) {
    chain.push(`状态：挂单成交中 @ ${entry.toFixed(entry >= 100 ? 2 : 4)}`);
    return { ...base, status: 'pending', direction: dirName, signal, order, outcome: null, waitingReason: '' };
  }
  const remainMin = Math.max(0, Math.round((order.timeStopAt - bars[lastIdx].time) / 60000));
  chain.push(`状态：已成交持仓中 · 损 ${stop.toFixed(entry >= 100 ? 2 : 4)} · 盈 ${tp.toFixed(entry >= 100 ? 2 : 4)} · 时间止损剩 ${remainMin} 分钟`);
  return { ...base, status: 'filled', direction: dirName, signal, order, outcome: null, waitingReason: '' };
}

// ==================== 展示辅助 ====================

export function fastStatusLabel(s: FastStatus): string {
  return s === 'pending' ? '成交中' : s === 'filled' ? '持仓中' : s === 'closed' ? '已了结' : '观望';
}
