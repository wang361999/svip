/**
 * 资金费率 Carry（Delta 中性套利）监控信号。
 * 逻辑：做多现货 + 做空等额永续，对冲涨跌，主要收益 = 收取永续资金费。
 * 本模块只读，给"开/持仓/观望/减仓"信号，全部基于真实资金费历史，无前视。
 * 注意：净收益为估计（需自行核对手续费/杠杆/滑点），且资金费 20~27% 时段为负（变为支出）。
 */

export interface FundingPoint {
  time: number;
  rate: number; // 单期(8h)资金费率
}

export type CarrySignal = '加仓' | '持仓' | '观望' | '减仓';

export interface CarryView {
  symbol: string;
  currentAnnual: number;       // 当前资金费 年化 %
  avg30Annual: number;         // 近30期 年化 %
  avg90Annual: number;         // 近90期 年化 %
  positiveRatio: number;       // 近90期正资金费占比 0~1
  z: number;                   // 拥挤度
  grossAnnual: number;         // 综合毛收益参考（80% 权重给 90日均 + 20% 给当前，取较低者求稳）
  feeEst: number;              // 费率成本估计（一次性开平，年化摊薄估计）
  netAnnual: number;           // 预估净收益 %
  signal: CarrySignal;
  reason: string;
  binance: { current: number; avg30: number; avg90: number; positive: number };
  okx: { current: number; avg30: number; avg90: number; positive: number } | null;
}

const PERIODS_PER_YEAR = 3 * 365; // 8h * 3 = 1天 → ×365

function toAnnual(r: number): number { return r * PERIODS_PER_YEAR * 100; }

function stats(pts: FundingPoint[], n: number) {
  const arr = pts.slice(-n);
  if (arr.length < 20) return { meanAnnual: 0, positive: 0, sd: 0, mean: 0 };
  const mean = arr.reduce((s, v) => s + v.rate, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((s, v) => s + (v.rate - mean) ** 2, 0) / arr.length);
  const pos = arr.filter((v) => v.rate > 0).length / arr.length;
  return { meanAnnual: toAnnual(mean), positive: pos, sd, mean };
}

export function calcCarryView(symbol: string, binance: FundingPoint[], okx?: FundingPoint[] | null): CarryView | null {
  if (!binance || binance.length < 60) return null;
  const sorted = [...binance].sort((a, b) => a.time - b.time);
  const s30 = stats(sorted, 30);
  const s90 = stats(sorted, 90);
  const cur = sorted[sorted.length - 1].rate;
  const curAnnual = toAnnual(cur);
  // 拥挤度 z（相对近90期，不含当前期）
  const win = sorted.slice(-90, -1);
  const z = win.length < 40 || s90.sd < 1e-9 ? 0 : (cur - s90.mean) / s90.sd;
  // 毛收益参考：若当前资金费高于 90日均则按均算（求稳，防止高位追），否则按当前乐观但也打折
  const grossAnnual = curAnnual > 0 && curAnnual < s90.meanAnnual ? curAnnual * 0.8 : s90.meanAnnual * 0.9;
  // 费用估计：现货 taker 0.1%×2 + 合约开平约 0.08%×2 ≈ 0.36% 一次性；做长期摊薄到年化（按持仓3个月）→ 1.5%
  const feeEst = 1.5;
  const netAnnual = grossAnnual - feeEst;

  // 信号规则（全部基于真实统计，宁缺勿滥）
  let signal: CarrySignal;
  let reason: string;
  const good = netAnnual >= 3 && s90.positive >= 0.65 && curAnnual > 0;
  if (good && curAnnual >= s90.meanAnnual * 1.2) {
    signal = '加仓';
    reason = `资金费居高(${curAnnual.toFixed(1)}%年化)，正占比${(s90.positive*100).toFixed(0)}%，套利空间足`;
  } else if (good) {
    signal = '持仓';
    reason = `正资金费可持续(${curAnnual.toFixed(1)}%年化)，相对稳定，可维持Delta中性仓`;
  } else if (netAnnual <= 0 || curAnnual <= 0) {
    signal = '减仓';
    reason = `当前资金费${curAnnual.toFixed(2)}%${curAnnual<0?'（为负=需付费）':'过低'}，净收益预估≤0，建议减仓/观望`;
  } else {
    signal = '观望';
    reason = `资金费${curAnnual.toFixed(1)}%年化但净收益预估仅${netAnnual.toFixed(1)}%，扣费后空间有限`;
  }

  const okxView = okx && okx.length >= 60 ? stats([...okx].sort((a,b)=>a.time-b.time), 30) : null;

  return {
    symbol,
    currentAnnual: curAnnual,
    avg30Annual: s30.meanAnnual,
    avg90Annual: s90.meanAnnual,
    positiveRatio: s90.positive,
    z,
    grossAnnual,
    feeEst,
    netAnnual,
    signal,
    reason,
    binance: { current: curAnnual, avg30: s30.meanAnnual, avg90: s90.meanAnnual, positive: s90.positive },
    okx: okxView ? { current: 0, avg30: okxView.meanAnnual, avg90: okxView.meanAnnual, positive: okxView.positive } : null,
  };
}

// ===== 双所永续对冲（纯合约 · Delta中性） =====
// 逻辑：资金费更低所开多腿，更高所开空腿，每8h收"净资金费 = 空腿所 - 多腿所"。
// 只做合约、不碰现货，但两腿都贴同一价格指数→净价差通常较薄，且依赖两所资金费分化。

export interface HedgeCarryView {
  pair: string;
  shortVenue: 'binance' | 'okx'; // 空腿所在所（资金费较高侧）
  longVenue: 'binance' | 'okx';  // 多腿所在所（资金费较低侧）
  shortAvg: number;              // 空腿所 近30日资金费 年化%
  longAvg: number;               // 多腿所 近30日资金费 年化%
  grossSpread: number;           // 净资金费价差 年化%（收）
  curSpread: number;             // 当前净资金费价差 年化%
  stableRatio: number;           // 近90期净资金费价差方向为正 占比
  feeEst: number;                // 两腿开平费用，年化摊薄估计
  netAnnual: number;             // 预估净收益 年化%
  signal: CarrySignal;
  reason: string;
}

// 按时间对齐 OKX 与 Binance 的 8h 资金费（允许 ±4.5h 窗口），返回逐期 (binance - okx)
function alignSpread(b: FundingPoint[], o: FundingPoint[]): number[] {
  const bs = [...b].sort((x, y) => x.time - y.time);
  const out: number[] = [];
  const window = 4.5 * 3600 * 1000;
  for (const op of o) {
    let lo = 0, hi = bs.length - 1, best = -1, bestD = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = Math.abs(bs[mid].time - op.time);
      if (d < bestD) { bestD = d; best = mid; }
      if (bs[mid].time < op.time) lo = mid + 1; else hi = mid - 1;
    }
    if (best >= 0 && bestD <= window) out.push(bs[best].rate - op.rate);
  }
  return out;
}

export function calcHedgeCarry(binance: FundingPoint[] | null, okx: FundingPoint[] | null): HedgeCarryView | null {
  if (!binance || binance.length < 60 || !okx || okx.length < 60) return null;
  const diffs = alignSpread(binance, okx);
  if (diffs.length < 30) return null;

  const meanD = diffs.reduce((s, v) => s + v, 0) / diffs.length;   // binance - okx
  const curD = diffs[diffs.length - 1];
  const shortIsBinance = meanD >= 0;
  const shortVenue: 'binance' | 'okx' = shortIsBinance ? 'binance' : 'okx';
  const longVenue: 'binance' | 'okx' = shortIsBinance ? 'okx' : 'binance';
  const absMean = Math.abs(meanD);
  const absCur = Math.abs(curD);
  const grossSpread = toAnnual(absMean);
  const curSpread = toAnnual(absCur);
  const stableRatio = shortIsBinance
    ? diffs.filter((d) => d > 0).length / diffs.length
    : diffs.filter((d) => d < 0).length / diffs.length;

  const b90 = [...binance].sort((a, b) => a.time - b.time).slice(-90);
  const o90 = [...okx].sort((a, b) => a.time - b.time).slice(-90);
  const means = (arr: FundingPoint[]) => toAnnual(arr.reduce((s, v) => s + v.rate, 0) / arr.length);
  const shortAvg = means(shortIsBinance ? b90 : o90);
  const longAvg = means(shortIsBinance ? o90 : b90);

  // 两腿开平（taker 各一次）约 0.3% 一次性，按持仓3个月摊薄到年化
  const feeEst = 1.2;
  const netAnnual = grossSpread - feeEst;

  let signal: CarrySignal;
  let reason: string;
  if (netAnnual >= 2.5 && stableRatio >= 0.6) {
    signal = '加仓';
    reason = `净价差${grossSpread.toFixed(1)}%年化，方向稳定${(stableRatio * 100).toFixed(0)}%：空${shortVenue === 'binance' ? 'Binance' : 'OKX'}多${longVenue === 'binance' ? 'Binance' : 'OKX'}`;
  } else if (netAnnual >= 1 && stableRatio >= 0.5) {
    signal = '持仓';
    reason = `净价差${grossSpread.toFixed(1)}%年化但仍为正(${stableRatio > 0 ? '方向稳定' + (stableRatio * 100).toFixed(0) + '%' : ''})，可维持对冲仓`;
  } else if (curSpread <= 0 || grossSpread < 0.5) {
    signal = '减仓';
    reason = `净价差过窄${grossSpread.toFixed(1)}%或倒挂(当前${curSpread.toFixed(1)}%)，两腿费用可能吃光，建议空仓等待分化`;
  } else {
    signal = '观望';
    reason = `净价差${grossSpread.toFixed(1)}%年化，扣两腿费用${feeEst.toFixed(1)}%后仅剩${netAnnual.toFixed(1)}%，空间有限`;
  }

  return {
    pair: 'ETH',
    shortVenue,
    longVenue,
    shortAvg,
    longAvg,
    grossSpread,
    curSpread,
    stableRatio,
    feeEst,
    netAnnual,
    signal,
    reason,
  };
}