/**
 * 多周期趋势分析（15分钟 / 1小时 / 4小时 / 1天）
 *
 * 判定逻辑：只按市场结构区分（道氏 HH/HL/LH/LL 摆动点加权投票），
 * 不加任何其他指标 — 与 AI 信号的方向过滤层完全同源，
 * 两面板结构结论永远一致。
 */
import { fetchKlines, type KlineData } from './market-data';
import { computeStructureTrend, type StructureInfo } from './ai-analysis';

export type TrendDirection = 'long' | 'short' | 'neutral';

export interface TrendTimeframe {
  /** 周期标识：15m | 1h | 4h | 1d */
  tf: string;
  /** 中文标签：15分钟 | 1小时 | 4小时 | 1天 */
  label: string;
  trend: TrendDirection;
  /** 结构摆动点序列描述（判定依据） */
  seq: string;
  /** 结构结论说明 */
  note: string;
}

export interface TrendAnalysis {
  symbol: string;
  label: string;
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

/** 单周期趋势判定（纯道氏结构，HH+HL=多 / LH+LL=空 / 高低点矛盾=震荡） */
function classifyTimeframe(tf: string, label: string, klines: KlineData[]): TrendTimeframe | null {
  if (klines.length < 60) return null; // 结构判定至少 60 根（摆动点序列足够）

  const s: StructureInfo = computeStructureTrend(klines, label);
  const trend: TrendDirection =
    s.trend === 'up' ? 'long' : s.trend === 'down' ? 'short' : 'neutral';

  return { tf, label, trend, seq: s.seq, note: s.note };
}

/** 分析多周期趋势（15m / 1h / 4h / 1d，纯结构） */
export async function analyzeTrend(
  symbol: string,
  okxId: string,
  label: string,
): Promise<TrendAnalysis> {
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

  return { symbol, label, timeframes, overall: { longCount, shortCount, neutralCount, trend, summary } };
}
