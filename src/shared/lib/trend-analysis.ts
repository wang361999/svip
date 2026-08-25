/**
 * 多周期趋势分析
 *
 * 对 15分钟 / 1小时 / 4小时 / 1天 四个周期分别判定趋势方向：
 * - 多头 / 空头 / 震荡
 *
 * 判定逻辑（多因子打分，共 5 项，每项 ±1）：
 * 1. 价格相对 EMA20 的位置（站上=+1，跌破=-1）
 * 2. EMA20 相对 SMA50 的位置（多头排列=+1，空头排列=-1）
 * 3. 价格相对 SMA200 的位置（长期趋势方向）
 * 4. MACD 柱状图方向（>0=多头动能，<0=空头动能）
 * 5. EMA20 斜率（近 10 根上倾=+1，下倾=-1）
 *
 * 综合判定：
 * - ADX < 18（无趋势）或 |score| < 2 → 震荡
 * - score >= +2 → 多头；score <= -2 → 空头
 */
import { fetchKlines, type KlineData } from './market-data';
import { calcADX, calcEMAArray, calcSMAArray, calcMACD } from './indicators';

export type TrendDirection = 'long' | 'short' | 'neutral';

export interface TrendTimeframe {
  /** 周期标识：15m | 1h | 4h | 1d */
  tf: string;
  /** 中文标签：15分钟 | 1小时 | 4小时 | 1天 */
  label: string;
  trend: TrendDirection;
  /** 归一化得分 -100 ~ +100（正=多头，负=空头） */
  score: number;
  /** ADX 趋势强度（0-100，>25 强趋势，<18 无趋势） */
  adx: number;
  /** 该周期最近收盘价 */
  close: number;
  /** 近 12 根 K 线累计涨跌幅 % */
  changePct: number;
  /** 命中的因子说明（最多 5 条） */
  reasons: string[];
}

export interface TrendAnalysis {
  symbol: string;
  label: string;
  currentPrice: number;
  timeframes: TrendTimeframe[];
  /** 四周期共振情况 */
  overall: {
    longCount: number;
    shortCount: number;
    neutralCount: number;
    /** 共识结论：多数派方向；无多数派为 neutral */
    trend: TrendDirection;
    summary: string;
  };
}

/** 单周期趋势判定 */
function classifyTimeframe(tf: string, label: string, klines: KlineData[]): TrendTimeframe | null {
  if (klines.length < 60) return null; // 数据不足（需要 SMA200 尽量可用，至少 60 根做核心判定）

  const last = klines.length - 1;
  const close = klines[last].close;

  const ema20Arr = calcEMAArray(klines, 20);
  const sma50Arr = calcSMAArray(klines, 50);
  const sma200Arr = calcSMAArray(klines, 200);
  const macd = calcMACD(klines, 12, 26, 9);
  const adx = calcADX(klines, 14);

  const ema20 = ema20Arr[last];
  const ema20Prev = ema20Arr[Math.max(0, last - 10)];
  const sma50 = sma50Arr[last];
  const sma200 = sma200Arr[last];

  let score = 0;
  const reasons: string[] = [];

  // 因子1：价格 vs EMA20
  if (ema20 != null) {
    if (close > ema20) { score++; reasons.push('价格站上EMA20'); }
    else { score--; reasons.push('价格跌破EMA20'); }
  }

  // 因子2：EMA20 vs SMA50（均线排列）
  if (ema20 != null && sma50 != null) {
    if (ema20 > sma50) { score++; reasons.push('EMA20>SMA50 多头排列'); }
    else { score--; reasons.push('EMA20<SMA50 空头排列'); }
  }

  // 因子3：价格 vs SMA200（长期方向）
  if (sma200 != null) {
    if (close > sma200) { score++; reasons.push('价格在SMA200上方'); }
    else { score--; reasons.push('价格在SMA200下方'); }
  }

  // 因子4：MACD 动能
  if (macd) {
    if (macd.lastHist > 0) { score++; reasons.push('MACD多头动能'); }
    else { score--; reasons.push('MACD空头动能'); }
  }

  // 因子5：EMA20 斜率
  if (ema20Prev != null) {
    if (ema20 > ema20Prev) { score++; reasons.push('EMA20上倾'); }
    else { score--; reasons.push('EMA20下倾'); }
  }

  // 归一化到 -100 ~ +100
  const normalized = Math.round((score / 5) * 100);

  // 综合判定：方向一致（|score|>=2）且 ADX 不处于无趋势区（>=18）
  let trend: TrendDirection;
  if (adx > 0 && adx < 18) {
    trend = 'neutral'; // ADX 显示无趋势 → 震荡
    reasons.push(`ADX=${adx.toFixed(0)} 无趋势`);
  } else if (score >= 2) {
    trend = 'long';
    if (adx >= 25) reasons.push(`ADX=${adx.toFixed(0)} 趋势强劲`);
  } else if (score <= -2) {
    trend = 'short';
    if (adx >= 25) reasons.push(`ADX=${adx.toFixed(0)} 趋势强劲`);
  } else {
    trend = 'neutral'; // 多空因子分歧 → 震荡
    reasons.push('多空因子分歧');
  }

  // 近 12 根累计涨跌幅
  const refIdx = Math.max(0, last - 11);
  const refClose = klines[refIdx].close;
  const changePct = refClose > 0 ? ((close - refClose) / refClose) * 100 : 0;

  return { tf, label, trend, score: normalized, adx: Math.round(adx), close, changePct: Number(changePct.toFixed(2)), reasons };
}

/** 分析多周期趋势（15m / 1h / 4h / 1d） */
export async function analyzeTrend(
  symbol: string,
  okxId: string,
  label: string,
): Promise<TrendAnalysis> {
  // 并行拉取四个周期（200 根足够 SMA200 和 ADX 计算）
  const [k15m, k1h, k4h, k1d] = await Promise.all([
    fetchKlines(symbol, okxId, '15m', 200).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '1h', 200).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '4h', 200).catch(() => [] as KlineData[]),
    fetchKlines(symbol, okxId, '1d', 200).catch(() => [] as KlineData[]),
  ]);

  const defs: [string, string, KlineData[]][] = [
    ['15m', '15分钟', k15m],
    ['1h', '1小时', k1h],
    ['4h', '4小时', k4h],
    ['1d', '1天', k1d],
  ];

  const timeframes: TrendTimeframe[] = [];
  for (const [tf, tfLabel, ks] of defs) {
    const r = classifyTimeframe(tf, tfLabel, ks);
    if (r) timeframes.push(r);
  }

  const longCount = timeframes.filter((t) => t.trend === 'long').length;
  const shortCount = timeframes.filter((t) => t.trend === 'short').length;
  const neutralCount = timeframes.filter((t) => t.trend === 'neutral').length;

  let trend: TrendDirection = 'neutral';
  let summary: string;
  if (longCount >= 3) {
    trend = 'long';
    summary = `多周期共振看多（${longCount}/4）`;
  } else if (shortCount >= 3) {
    trend = 'short';
    summary = `多周期共振看空（${shortCount}/4）`;
  } else if (longCount > 0 && longCount === shortCount) {
    summary = `多空分歧（多${longCount}/空${shortCount}），建议观望`;
  } else if (longCount > shortCount && longCount > 0) {
    trend = 'long';
    summary = `偏多（多${longCount}/空${shortCount}/震荡${neutralCount}）`;
  } else if (shortCount > longCount && shortCount > 0) {
    trend = 'short';
    summary = `偏空（空${shortCount}/多${longCount}/震荡${neutralCount}）`;
  } else {
    summary = '各周期均为震荡';
  }

  // 当前价格：取最小周期（15m）的最新收盘，无则用 1h
  const currentPrice = k15m.length > 0
    ? k15m[k15m.length - 1].close
    : k1h.length > 0 ? k1h[k1h.length - 1].close : 0;

  return { symbol, label, currentPrice, timeframes, overall: { longCount, shortCount, neutralCount, trend, summary } };
}
