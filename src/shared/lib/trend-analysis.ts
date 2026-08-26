// 多周期多空分析 - 基于已有指标函数

import { KlineData } from './market-data';
import { calcEMAArray, calcBollinger, calcMACD, calcRSIArray, calcATRArray } from './indicators';

export type Direction = '多' | '空' | '震荡';

export interface IndicatorSignal {
  ema: Direction;
  boll: Direction;
  macd: Direction;
  rsi: Direction;
  atr: Direction;      // ATR 无方向，用价格动量替代
  vol: Direction;     // 成交量确认
}

export interface TimeframeResult {
  timeframe: string;
  signals: IndicatorSignal;
  overall: Direction;       // 综合多空
  score: number;             // -6 ~ +6
  lastPrice: number;
  support: number | null;   // 最近支撑位
  resistance: number | null;// 最近阻力位
}

export interface FundingRate {
  rate: number;        // 原始费率，如 0.0001 = 0.01%
  direction: Direction; // 反向信号：高正费率→空，高负费率→多
  text: string;        // 描述文本
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
  const atrExpanding = atrLast != null && atrMid != null && atrLast > atrMid;
  const atr: Direction = !atrExpanding ? '震荡' : close > prevClose ? '多' : '空';

  // --- 成交量确认 ---
  const volLen = Math.min(20, klines.length - 1);
  const volumes = klines.slice(-volLen).map((k) => k.volume);
  const avgVol = volumes.reduce((s, v) => s + v, 0) / volLen;
  const recentVol = klines[klines.length - 1].volume;
  const volExpanding = recentVol > avgVol * 1.3;
  const vol: Direction = !volExpanding ? '震荡' : close > prevClose ? '多' : '空';

  const signals: IndicatorSignal = { ema, boll: bollDir, macd: macdDir, rsi, atr, vol };

  // 综合评分（6个指标）
  const score = [ema, bollDir, macdDir, rsi, atr, vol].reduce((s, d) => {
    if (d === '多') return s + 1;
    if (d === '空') return s - 1;
    return s;
  }, 0);

  let overall: Direction;
  if (score >= 3) overall = '多';
  else if (score <= -3) overall = '空';
  else overall = '震荡';

  // --- 关键价位（分形法找支撑/阻力）---
  const strength = 3;
  const fbStart = strength;
  const fbEnd = klines.length - strength - 1;
  const fractalHighs: number[] = [];
  const fractalLows: number[] = [];
  for (let i = fbStart; i <= fbEnd; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (klines[i].high <= klines[i - j].high || klines[i].high <= klines[i + j].high) isHigh = false;
      if (klines[i].low >= klines[i - j].low || klines[i].low >= klines[i + j].low) isLow = false;
    }
    if (isHigh) fractalHighs.push(klines[i].high);
    if (isLow) fractalLows.push(klines[i].low);
  }
  // 最近的阻力（在当前价上方）和支撑（在当前价下方）
  const resistance = fractalHighs.filter((h) => h > close).sort((a, b) => a - b)[0] || null;
  const support = fractalLows.filter((l) => l < close).sort((a, b) => b - a)[0] || null;

  return {
    timeframe: TF_LABELS[tf] || tf,
    signals,
    overall,
    score,
    lastPrice: close,
    support,
    resistance,
  };
}

/**
 * 解析资金费率（反向指标）
 * @param rate 原始费率，如 0.0001 = 0.01%
 */
export function parseFundingRate(rate: number): FundingRate {
  // 费率极端时是反向信号
  // 正费率高 = 多头拥挤 → 看空
  // 负费率低 = 空头拥挤 → 看多
  const absRate = Math.abs(rate);
  let direction: Direction;
  let text: string;

  if (rate > 0.0005) {
    direction = '空';
    text = `费率 ${(rate * 100).toFixed(3)}%，多头拥挤，反转风险`;
  } else if (rate > 0.0001) {
    direction = '空';
    text = `费率 ${(rate * 100).toFixed(3)}%，偏多拥挤`;
  } else if (rate < -0.0005) {
    direction = '多';
    text = `费率 ${(rate * 100).toFixed(3)}%，空头拥挤，反弹机会`;
  } else if (rate < -0.0001) {
    direction = '多';
    text = `费率 ${(rate * 100).toFixed(3)}%，偏空拥挤`;
  } else {
    direction = '震荡';
    text = `费率 ${(rate * 100).toFixed(3)}%，中性`;
  }

  return { rate, direction, text };
}
