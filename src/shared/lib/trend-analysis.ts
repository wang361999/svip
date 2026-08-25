/**
 * 多周期趋势分析（15分钟 / 1小时 / 4小时 / 1天）
 *
 * 判定逻辑：道氏市场结构（HH/HL/LH/LL 摆动点加权投票）— 与 AI 信号的方向过滤层完全同源，
 * 保证本面板与 AI 面板的结构结论永远一致（不再出现指标说多、结构说空的矛盾）。
 *
 * 每周期同时展示辅助信息（不参与方向判定）：
 * - ADX 趋势强度、因子得分、近 12 根涨跌幅
 */
import { fetchKlines, type KlineData } from './market-data';
import { calcADX, calcEMAArray, calcSMAArray, calcMACD } from './indicators';
import { computeStructureTrend } from './ai-analysis';

export type TrendDirection = 'long' | 'short' | 'neutral';

export interface TrendTimeframe {
  /** 周期标识：15m | 1h | 4h | 1d */
  tf: string;
  /** 中文标签：15分钟 | 1小时 | 4小时 | 1天 */
  label: string;
  trend: TrendDirection;
  /** 归一化得分 -100 ~ +100（正=多头，负=空头）— 辅助信息，不参与方向判定 */
  score: number;
  /** ADX 趋势强度（0-100，>25 强趋势，<18 无趋势）— 辅助信息 */
  adx: number;
  /** 该周期最近收盘价 */
  close: number;
  /** 近 12 根 K 线累计涨跌幅 % */
  changePct: number;
  /** 命中的因子说明（结构结论 + 辅助指标） */
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

/** 单周期趋势判定（道氏结构为准，指标为辅） */
function classifyTimeframe(tf: string, label: string, klines: KlineData[]): TrendTimeframe | null {
  if (klines.length < 60) return null; // 结构判定至少 60 根（摆动点序列足够）

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

  // 因子1：价格 vs EMA20
  if (ema20 != null) score += close > ema20 ? 1 : -1;
  // 因子2：EMA20 vs SMA50（均线排列）
  if (ema20 != null && sma50 != null) score += ema20 > sma50 ? 1 : -1;
  // 因子3：价格 vs SMA200（长期方向）
  if (sma200 != null) score += close > sma200 ? 1 : -1;
  // 因子4：MACD 动能
  if (macd) score += macd.lastHist > 0 ? 1 : -1;
  // 因子5：EMA20 斜率
  if (ema20Prev != null) score += ema20 > ema20Prev ? 1 : -1;

  // 归一化到 -100 ~ +100（辅助信息）
  const normalized = Math.round((score / 5) * 100);

  // 方向判定：道氏结构（与 AI 方向过滤层同源同值）
  const structure = computeStructureTrend(klines, label);
  const trend: TrendDirection =
    structure.trend === 'up' ? 'long' : structure.trend === 'down' ? 'short' : 'neutral';

  const reasons: string[] = [structure.note || `${label}结构不明`];
  if (structure.trend === 'up') reasons.push('HH+HL 摆动点加权占优');
  if (structure.trend === 'down') reasons.push('LH+LL 摆动点加权占优');
  if (structure.trend === 'range') reasons.push('高低点矛盾，结构震荡');
  if (adx >= 25) reasons.push(`ADX=${adx.toFixed(0)} 趋势强劲（辅助）`);
  else if (adx > 0 && adx < 18) reasons.push(`ADX=${adx.toFixed(0)} 动能弱（辅助）`);

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
