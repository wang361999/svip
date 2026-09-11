import { useMemo } from 'react';
import {
  calcEMAArray, calcBollinger, calcMACD, calcRSIArray,
  calcATRArray, calcADX, calcSuperTrend,
} from '@/shared/lib/indicators';
import type { KlineData } from '@/shared/lib/market-data';

/**
 * 市场环境卡
 * 只回答「现在市场是什么状态」，不预测方向（回测：KDJ/VWAP/九转/缠论笔 无稳定预测力，已删）。
 * 买卖结论统一看左侧「交易决策」卡，这里不投票、不给多空暗示。
 */

interface Props {
  klines: KlineData[];
  refreshKey?: number;
  precision?: number;
  symbol?: string;
}

type Tone = 'up' | 'down' | 'flat';

const TONE_CLS: Record<Tone, string> = {
  up: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
  down: 'bg-red-500/15 border-red-500/40 text-red-300',
  flat: 'bg-dark-700/50 border-dark-600/60 text-dark-300',
};

function Cell({ name, tag, tagTone, value, note }: { name: string; tag: string; tagTone: Tone; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 p-2.5 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] text-dark-200 font-medium truncate">{name}</span>
        <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${TONE_CLS[tagTone]}`}>{tag}</span>
      </div>
      <div className="text-[11px] font-mono tabular-nums text-slate-200 leading-tight break-all">{value}</div>
      <div className="text-[10px] text-dark-400 leading-tight break-words">{note}</div>
    </div>
  );
}

export default function IndicatorPanel({ klines, refreshKey = 0, precision = 2, symbol = '' }: Props) {
  const m = useMemo(() => {
    void refreshKey;
    const cur = klines.length ? klines[klines.length - 1].close : null;
    const fmt = (v: number | null | undefined) => (v == null || !isFinite(v) ? '--' : v.toFixed(precision));
    const lastN = (arr: (number | null)[]): number | null => {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && isFinite(arr[i] as number)) return arr[i] as number;
      return null;
    };

    const ema9 = lastN(calcEMAArray(klines, 9));
    const ema20 = lastN(calcEMAArray(klines, 20));
    const ema60 = lastN(calcEMAArray(klines, 60));
    const macd = calcMACD(klines, 12, 26, 9);
    const histPrev = macd && macd.hist.length >= 2 ? macd.hist[macd.hist.length - 2] : null;
    const rsi = lastN(calcRSIArray(klines, 14));
    const boll = calcBollinger(klines, 20);
    const bandPos = boll && cur != null && boll.upper > boll.lower ? ((cur - boll.lower) / (boll.upper - boll.lower)) * 100 : null;
    const atr = lastN(calcATRArray(klines, 14));
    const atrPct = atr != null && cur ? (atr / cur) * 100 : null;
    const adx = calcADX(klines, 14);
    const st = calcSuperTrend(klines, 10, 3);

    return { cur, fmt, ema9, ema20, ema60, macd, histPrev, rsi, boll, bandPos, atr, atrPct, adx, st };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klines, refreshKey, precision]);

  if (!m.cur) {
    return <div className="rounded-xl border border-cyan-500/20 bg-dark-800/30 px-4 py-3 text-xs text-dark-400">市场环境 · 等待K线数据</div>;
  }
  const { cur, fmt, ema9, ema20, ema60, macd, histPrev, rsi, boll, bandPos, atr, atrPct, adx, st } = m;

  // 1) 均线排列：说人话的趋势现状
  let emaTag: Tone = 'flat';
  let emaText = '均线缠绕，方向未定';
  if (ema9 != null && ema20 != null && ema60 != null) {
    if (cur > ema9 && ema9 > ema20 && ema20 > ema60) { emaTag = 'up'; emaText = '多头排列（价>9日>20日>60日），上升趋势中'; }
    else if (cur < ema9 && ema9 < ema20 && ema20 < ema60) { emaTag = 'down'; emaText = '空头排列（价<9日<20日<60日），下降趋势中'; }
    else { emaText = `价在均线之间（${cur > ema20 ? '在20日上方' : '在20日下方'}），趋势不连贯`; }
  }

  // 2) MACD：只描述动能强弱变化
  let macdTag: Tone = 'flat';
  let macdText = '数据不足';
  if (macd) {
    const h = macd.lastHist;
    const growing = histPrev != null && h > histPrev;
    if (h > 0 && growing) { macdTag = 'up'; macdText = '红柱还在放大，上涨动能增强'; }
    else if (h > 0) { macdTag = 'flat'; macdText = '红柱开始缩短，上涨动能减弱'; }
    else if (h < 0 && !growing) { macdTag = 'down'; macdText = '绿柱还在放大，下跌动能增强'; }
    else { macdTag = 'flat'; macdText = '绿柱开始缩短，下跌动能减弱'; }
  }

  // 3) RSI：冷热
  let rsiTag: Tone = 'flat';
  let rsiText = '中性区间，不冷不热';
  if (rsi != null) {
    if (rsi >= 80) { rsiTag = 'down'; rsiText = '极度超买（≥80），随时可能回调'; }
    else if (rsi >= 70) { rsiTag = 'down'; rsiText = '超买（≥70），追高风险大'; }
    else if (rsi <= 20) { rsiTag = 'up'; rsiText = '极度超卖（≤20），随时可能反弹'; }
    else if (rsi <= 30) { rsiTag = 'up'; rsiText = '超卖（≤30），杀跌空间有限'; }
  }

  // 4) 布林位置
  let bollTag: Tone = 'flat';
  let bollText = '在轨道中部，正常波动';
  if (bandPos != null) {
    if (bandPos >= 90) { bollTag = 'down'; bollText = `贴上轨（${bandPos.toFixed(0)}%），涨过头`; }
    else if (bandPos >= 70) { bollTag = 'flat'; bollText = `轨道上半部（${bandPos.toFixed(0)}%），偏强但不极端`; }
    else if (bandPos <= 10) { bollTag = 'up'; bollText = `贴下轨（${bandPos.toFixed(0)}%），跌过头`; }
    else if (bandPos <= 30) { bollTag = 'flat'; bollText = `轨道下半部（${bandPos.toFixed(0)}%），偏弱但不极端`; }
  }

  // 5) ADX：有没有趋势
  let adxTag: Tone = 'flat';
  let adxText = '数据不足';
  if (adx && adx.lastADX > 0) {
    if (adx.lastADX >= 25) {
      adxTag = adx.direction === 'bull' ? 'up' : adx.direction === 'bear' ? 'down' : 'flat';
      adxText = `ADX ${adx.lastADX.toFixed(0)}，趋势行情（${adx.direction === 'bull' ? '向上' : adx.direction === 'bear' ? '向下' : '方向相持'}），顺势单存活率高`;
    } else {
      adxText = `ADX ${adx.lastADX.toFixed(0)}，震荡行情，没有趋势，追涨杀跌容易被来回打脸`;
    }
  }

  // 6) SuperTrend：价格在跟踪线哪一侧
  let stTag: Tone = 'flat';
  let stText = '数据不足';
  if (st?.lastIsUp != null) {
    stTag = st.lastIsUp ? 'up' : 'down';
    stText = st.lastIsUp ? `价格在跟踪线上方（${fmt(st.lastValue)}），持多思路` : `价格在跟踪线下方（${fmt(st.lastValue)}），持空思路`;
  }

  return (
    <div className="rounded-xl border border-cyan-500/20 bg-dark-800/30 overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1.5 border-b border-dark-700/40 flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-slate-200">市场环境{symbol ? ` · ${symbol}` : ''}</span>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-dark-600/60 bg-dark-700/50 text-dark-300">
          现价 {fmt(cur)}
        </span>
        <span className="ml-auto text-[10px] text-dark-500">只描述现状，买卖看决策卡</span>
      </div>

      <div className="grid grid-cols-2 gap-2 p-3">
        <Cell name="均线趋势" tag={emaText.includes('多头') ? '多头' : emaText.includes('空头') ? '空头' : '纠缠'} tagTone={emaTag}
          value={`EMA ${fmt(ema9)} / ${fmt(ema20)} / ${fmt(ema60)}`} note={emaText} />
        <Cell name="MACD动能" tag={macdTag === 'up' ? '增强' : macdTag === 'down' ? '走弱' : '转折'} tagTone={macdTag}
          value={macd ? `柱 ${fmt(macd.lastHist)}` : '--'} note={macdText} />
        <Cell name="RSI冷热" tag={rsi != null && rsi >= 70 ? '超买' : rsi != null && rsi <= 30 ? '超卖' : '正常'} tagTone={rsiTag}
          value={rsi != null ? fmt(rsi) : '--'} note={rsiText} />
        <Cell name="布林位置" tag={bandPos != null && bandPos >= 85 ? '贴上轨' : bandPos != null && bandPos <= 15 ? '贴下轨' : '轨道内'} tagTone={bollTag}
          value={boll ? `上 ${fmt(boll.upper)} / 下 ${fmt(boll.lower)}` : '--'} note={bollText} />
        <Cell name="趋势强度ADX" tag={adx && adx.lastADX >= 25 ? '趋势' : '震荡'} tagTone={adxTag}
          value={adx && adx.lastADX > 0 ? `ADX ${fmt(adx.lastADX)}` : '--'} note={adxText} />
        <Cell name="SuperTrend" tag={st?.lastIsUp ? '线上' : st?.lastIsUp === false ? '线下' : '--'} tagTone={stTag}
          value={st.lastValue != null ? fmt(st.lastValue) : '--'} note={stText} />
      </div>

      <div className="mx-3 mb-3 rounded-lg bg-dark-900/40 border border-dark-700/50 px-2.5 py-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums">
        <span className="text-dark-300">单根平均波动 ATR</span>
        <span className="text-slate-200">{fmt(atr)} <span className="text-dark-400">({atrPct != null ? `${atrPct.toFixed(2)}%` : '--'})</span></span>
      </div>
      <div className="mt-auto px-3 py-1.5 border-t border-dark-700/40 text-[9.5px] text-dark-500 leading-tight">
        ATR 是止损宽度的尺子：止损至少留 1 倍 ATR，否则容易被正常波动扫出局
      </div>
    </div>
  );
}
