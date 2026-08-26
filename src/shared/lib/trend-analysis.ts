// 多周期多空分析 - 基于已有指标函数

import { KlineData } from './market-data';
import { calcEMAArray, calcBollinger, calcMACD, calcRSIArray, calcATRArray } from './indicators';

export type Direction = '多' | '空' | '震荡';

export interface IndicatorSignal {
  ema: Direction;
  boll: Direction;
  macd: Direction;
  rsi: Direction;
  atr: Direction;    // ATR 无方向，用价格动量替代
}

export interface TimeframeResult {
  timeframe: string;
  signals: IndicatorSignal;
  overall: Direction;       // 综合多空
  score: number;             // -5 ~ +5
  lastPrice: number;
}

const TF_LABELS: Record<string, string> = {
  '15m': '15分钟',
  '1h': '1小时',
  '4h': '4小时',
  '1d': '1天',
};

/**
 * 分析单个周期的多空信号
 */
export function analyzeTimeframe(klines: KlineData[], tf: string): TimeframeResult | null {
  if (!klines || klines.length < 35) return null;

  const close = klines[klines.length - 1].close;
  const prevClose = klines[klines.length - 2].close;

  // --- EMA ---
  const emaArr = calcEMAArray(klines, 20);
  const emaLast = emaArr[emaArr.length - 1];
  const ema: Direction = !emaLast ? '震荡' : close > emaLast ? '多' : '空';

  // --- 布林带 ---
  const boll = calcBollinger(klines, 20);
  const bollDir: Direction = !boll ? '震荡' : close > boll.middle ? '多' : '空';

  // --- MACD ---
  const macd = calcMACD(klines);
  const macdDir: Direction = !macd ? '震荡' : macd.lastHist > 0 ? '多' : macd.lastHist < 0 ? '空' : '震荡';

  // --- RSI ---
  const rsiArr = calcRSIArray(klines, 14);
  const rsiLast = rsiArr[rsiArr.length - 1];
  const rsi: Direction = rsiLast == null ? '震荡' : rsiLast > 50 ? '多' : '空';

  // --- ATR（无方向，用价格动量 + 波动率状态）---
  const atrArr = calcATRArray(klines, 14);
  const atrLast = atrArr[atrArr.length - 1];
  const atrMid = atrArr.length > 14 ? atrArr[atrArr.length - 14] : null;
  const volExpanding = atrLast != null && atrMid != null && atrLast > atrMid;
  const atr: Direction = !volExpanding ? '震荡' : close > prevClose ? '多' : '空';

  const signals: IndicatorSignal = { ema, boll: bollDir, macd: macdDir, rsi, atr };

  // 综合评分
  const score = [ema, bollDir, macdDir, rsi, atr].reduce((s, d) => {
    if (d === '多') return s + 1;
    if (d === '空') return s - 1;
    return s;
  }, 0);

  let overall: Direction;
  if (score >= 3) overall = '多';
  else if (score <= -3) overall = '空';
  else overall = '震荡';

  return {
    timeframe: TF_LABELS[tf] || tf,
    signals,
    overall,
    score,
    lastPrice: close,
  };
}
