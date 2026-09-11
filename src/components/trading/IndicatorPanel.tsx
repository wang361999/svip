import { useMemo, type ReactNode } from 'react';
import {
  calcEMAArray, calcBollinger, calcMACD, calcRSIArray, calcVWAPArray,
  calcATRArray, calcKDJ, calcNineTurn, calcChan, calcADX, calcSuperTrend,
} from '@/shared/lib/indicators';
import type { KlineData } from '@/shared/lib/market-data';

interface Props {
  klines: KlineData[];
  refreshKey?: number;
  precision?: number;
  symbol?: string;
}

type V = 'bull' | 'bear' | 'osc';
const CHIP: Record<V, { chip: string; label: string }> = {
  bull: { chip: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400', label: '多' },
  bear: { chip: 'bg-red-500/15 border-red-500/40 text-red-400', label: '空' },
  osc: { chip: 'bg-amber-500/15 border-amber-500/40 text-amber-400', label: '衡' },
};

function Card({ name, verdict, value, note }: { name: string; verdict?: V; value: string; note?: string }) {
  const c = CHIP[verdict ?? 'osc'];
  return (
    <div className="rounded-lg border border-dark-700/50 bg-dark-800/40 p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] text-dark-200 font-medium truncate">{name}</span>
        {verdict ? (
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${c.chip}`}>{c.label}</span>
        ) : null}
      </div>
      <div className="text-[11px] font-mono tabular-nums text-dark-300 leading-tight break-all">{value}</div>
      {note ? <div className="text-[10px] text-dark-400 leading-tight break-words">{note}</div> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-dark-500">{title}</div>
      <div className="grid grid-cols-2 gap-2 px-3 pb-3">{children}</div>
    </div>
  );
}

export default function IndicatorPanel({ klines, refreshKey = 0, precision = 2, symbol = '' }: Props) {
  const memo = useMemo(() => {
    void refreshKey;
    const cur = klines.length ? klines[klines.length - 1].close : null;
    const fmt = (v: number | null | undefined) => (v == null || !isFinite(v) ? '--' : v.toFixed(precision));
    const lastN = (arr: (number | null)[]): number | null => {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && isFinite(arr[i] as number)) return arr[i] as number;
      return null;
    };

    // 副图 · 动量
    const ema9 = lastN(calcEMAArray(klines, 9));
    const ema20 = lastN(calcEMAArray(klines, 20));
    const ema60 = lastN(calcEMAArray(klines, 60));
    const macd = calcMACD(klines, 12, 26, 9);
    const macdArr = macd ? macd.hist : [];
    const histNow = macd ? macd.lastHist : null;
    const difCur = macd ? macd.lastDif : null;
    const deaCur = macd ? macd.lastDea : null;
    const difPrev = macd && macd.dif.length >= 2 ? macd.dif[macd.dif.length - 2] : null;
    const deaPrev = macd && macd.dea.length >= 2 ? macd.dea[macd.dea.length - 2] : null;
    const rsi = lastN(calcRSIArray(klines, 14));
    const kdj = calcKDJ(klines, 9, 3, 3);
    const kPrev = kdj && kdj.k.length >= 2 ? kdj.k[kdj.k.length - 2] : null;
    const dPrev = kdj && kdj.d.length >= 2 ? kdj.d[kdj.d.length - 2] : null;

    // 副图 · 趋势/波动
    const boll = calcBollinger(klines, 20);
    const bandPos = boll && cur != null && boll.upper > boll.lower ? ((cur - boll.lower) / (boll.upper - boll.lower)) * 100 : null;
    const vwap = lastN(calcVWAPArray(klines));
    const atr = lastN(calcATRArray(klines, 14));
    const atrPct = atr != null && cur ? (atr / cur) * 100 : null;
    const adx = calcADX(klines, 14);
    const st = calcSuperTrend(klines, 10, 3);

    // 主图 · 结构
    const nine = calcNineTurn(klines);
    let nineVal: number = 0;
    for (let i = nine.length - 1; i >= 0; i--) { if (nine[i].value !== 0) { nineVal = nine[i].value; break; } }
    const chan = calcChan(klines);
    const chanLast = chan.bis.length ? chan.bis[chan.bis.length - 1] : null;
    const chanSig = chanSignals(chan.signals);

    // —— 判定 ——
    const macdVd: V = histNow == null ? 'osc' : histNow > 0 ? 'bull' : 'bear';
    const macdCross = difCur != null && deaCur != null && difPrev != null && deaPrev != null
      ? (difPrev <= deaPrev && difCur > deaCur ? '金叉' : difPrev >= deaPrev && difCur < deaCur ? '死叉' : null)
      : null;
    const rsiVd: V = rsi == null ? 'osc' : rsi >= 70 ? 'bear' : rsi <= 30 ? 'bull' : 'osc';
    const kdjVd: V = kdj == null ? 'osc' : (kdj.lastK >= 80 || kdj.lastJ >= 100) ? 'bear' : (kdj.lastK <= 20 || kdj.lastJ <= 0) ? 'bull' : 'osc';
    const kdjCross = kdj && kPrev != null && dPrev != null
      ? (kPrev <= dPrev && kdj.lastK > kdj.lastD ? '金叉' : kPrev >= dPrev && kdj.lastK < kdj.lastD ? '死叉' : null)
      : null;
    const emaVd: V = cur == null || ema20 == null || ema60 == null ? 'osc'
      : (cur > ema20 && ema20 > ema60) ? 'bull' : (cur < ema20 && ema20 < ema60) ? 'bear' : 'osc';
    const bollVd: V = bandPos == null ? 'osc' : bandPos >= 85 ? 'bear' : bandPos <= 15 ? 'bull' : 'osc';
    const vwapVd: V = cur == null || vwap == null ? 'osc' : cur >= vwap ? 'bull' : 'bear';
    const nineIsBuy = nineVal > 0;
    const nineCnt = Math.abs(nineVal);
    const nineVd: V = nineCnt >= 8 ? (nineIsBuy ? 'bull' : 'bear') : 'osc';
    const chanVd: V = chanLast ? (chanLast.direction === 'up' ? 'bull' : 'bear') : 'osc';
    const stVd: V = cur == null || st.lastIsUp == null ? 'osc' : st.lastIsUp ? 'bull' : 'bear';
    const adxVd: V = adx ? adx.direction : 'osc';
    const adxStrong = adx && adx.lastADX > 0 ? adx.lastADX : null;

    return {
      cur, fmt, ema9, ema20, ema60, emaVd, macd, macdVd, macdCross, rsi, rsiVd,
      kdj, kdjVd, kdjCross, boll, bandPos, bollVd, vwap, vwapVd, atr, atrPct,
      adx, adxVd, adxStrong, st, stVd,
      nineIsBuy, nineCnt, nineVd, chan, chanLast, chanSig, chanVd,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klines, refreshKey, precision]);

  const { cur, fmt, ema9, ema20, ema60, emaVd, macd, macdVd, macdCross, rsi, rsiVd,
    kdj, kdjVd, kdjCross, boll, bandPos, bollVd, vwap, vwapVd, atr, atrPct,
    adx, adxVd, adxStrong, st, stVd,
    nineIsBuy, nineCnt, nineVd, chanLast, chanSig, chanVd } = memo;

  if (!cur) {
    return <div className="rounded-xl border border-dark-700/60 bg-dark-800/30 px-3 py-3 text-xs text-dark-400">指标 · 等待K线数据</div>;
  }

  const up = [...(ema20 != null ? [ema20] : []), ema60 != null ? ema60 : 0].filter((x) => x > 0);
  const bullAlign = cur > (up[0] ?? 0);
  const bearAlign = cur < (up[0] ?? 0);

  let read = '—';
  const votes = [macdVd === 'bull', rsiVd === 'bull', kdjVd === 'bull', bollVd !== 'bear', vwapVd === 'bull', nineVd === 'bull', chanVd === 'bull', stVd === 'bull'];
  const bullN = votes.filter(Boolean).length;
  const bearN = votes.length - bullN;
  read = bullN > bearN ? `系统读数偏多（${bullN}/${votes.length}项），现价${bullAlign ? '站上均线' : '逼近均线'}；盯 MACD 柱${(macdCross ?? '')}与 RSI 是否过热`
    : bearN > bullN ? `系统读数偏空（${bearN}/${votes.length}项）；现价${bearAlign ? '跌破均线' : '承压'}，观察 MACD${(macdCross ?? '')}与是否超卖`
    : `系统读数中性（多空均衡），等均线方向或 MACD 柱${(macdCross ?? '')}明确`;

  return (
    <div className="rounded-xl border border-cyan-500/20 bg-dark-800/30 overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap px-3 pt-2.5 pb-1 border-b border-dark-700/40">
        <span className="text-xs font-semibold text-slate-200">指标{symbol ? ` · ${symbol}` : ''}</span>
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${CHIP[bullN >= bearN ? 'bull' : 'bear'].chip}`}>
          现价 {fmt(cur)}
        </span>
      </div>

      <Section title="副图 · 动量">
        <Card name="MACD(12,26,9)" verdict={macdVd}
          value={macd ? `DIF ${fmt(macd.lastDif)} · DEA ${fmt(macd.lastDea)} · 柱 ${fmt(macd.lastHist)}` : '--'}
          note={macdCross ? `${macdCross}（DIF/DEA）` : (macd ? `柱体${macd.lastHist >= 0 ? '红' : '绿'}，动量${macd.lastHist >= 0 ? '偏多' : '偏空'}` : '数据不足')} />
        <Card name="RSI(14)" verdict={rsiVd}
          value={rsi != null ? fmt(rsi) : '--'}
          note={rsi == null ? '--' : rsi >= 70 ? '超买(≥70)，留意回调' : rsi <= 30 ? '超卖(≤30)，留意反弹' : '中性，无明显超买卖'} />
        <Card name="KDJ(9,3,3)" verdict={kdjVd}
          value={kdj ? `K ${fmt(kdj.lastK)} · D ${fmt(kdj.lastD)} · J ${fmt(kdj.lastJ)}` : '--'}
          note={kdjCross ? `${kdjCross}（K/D）` : (kdj ? `J ${kdj.lastJ >= 100 ? '超买极值' : kdj.lastJ <= 0 ? '超卖极值' : '未到极值'}` : '--')} />
      </Section>

      <Section title="副图 · 趋势 / 波动">
        <Card name="EMA(9/20/60)" verdict={emaVd}
          value={`${fmt(ema9)} / ${fmt(ema20)} / ${fmt(ema60)}`}
          note={cur != null && ema20 != null && ema60 != null
            ? (cur > ema20 && ema20 > ema60 ? '多头排列' : cur < ema20 && ema20 < ema60 ? '空头排列' : '缠绕(方向未定)')
            : '--'} />
        <Card name="BOLL(20)" verdict={bollVd}
          value={boll ? `上 ${fmt(boll.upper)} · 中 ${fmt(boll.middle)} · 下 ${fmt(boll.lower)}` : '--'}
          note={bandPos != null ? `现价位于带宽 ${bandPos.toFixed(1)}%${bandPos >= 85 ? '（贴上轨，压力）' : bandPos <= 15 ? '（贴下轨，支撑）' : '（中轨附近）'}` : '--'} />
        <Card name="VWAP" verdict={vwapVd}
          value={vwap != null ? fmt(vwap) : '--'}
          note={vwap != null && cur != null ? `现价${cur >= vwap ? '上' : '下'}方 · ${(((cur - vwap) / vwap) * 100).toFixed(2)}%` : '需成交量'} />
        <Card name="ATR(14)" verdict="osc"
          value={`${fmt(atr)} · 占价 ${atrPct != null ? atrPct.toFixed(2) + '%' : '--'}`}
          note={atrPct != null ? `日内波动${atrPct.toFixed(2)}%；参考单根止损 ≈ ${fmt(atr ?? null)}` : '--'} />
      </Section>

      <Section title="趋势跟踪">
        <Card name="SuperTrend(10,3)" verdict={stVd}
          value={st.lastValue != null ? `${st.lastIsUp ? '上轨' : '下轨'} ${fmt(st.lastValue)}` : '--'}
          note={cur != null && st.lastIsUp != null ? (st.lastIsUp ? `现价沿上轨运行，趋势偏多` : `现价沿下轨运行，趋势偏空`) : '--'} />
        <Card name="ADX / DMI(14)" verdict={adxVd}
          value={adx ? `+DI ${fmt(adx.plusDI)} · -DI ${fmt(adx.minusDI)} · ADX ${fmt(adxStrong)}` : '--'}
          note={adx == null ? '--' : adxStrong == null ? '需更多数据推趋势强度' : adxStrong >= 25 ? `ADX ${fmt(adxStrong)} 趋势强，方向${adxVd === 'bull' ? '偏多' : adxVd === 'bear' ? '偏空' : '两方相持'}` : `ADX ${fmt(adxStrong)} 偏弱，规避震荡追单`} />
      </Section>

      <Section title="主图 · 结构">
        <Card name="九转" verdict={nineVd}
          value={nineCnt > 0 ? `第 ${nineCnt} 格 · ${nineIsBuy ? '买入序列(低点)' : '卖出序列(高点)'}` : '无进行中序列'}
          note={nineCnt >= 8 ? `${nineIsBuy ? '买' : '卖'}序列临近 9，注意反转/延续窗口` : nineCnt >= 5 ? `${nineIsBuy ? '买' : '卖'}序列进行中` : '序列方起步或未成'} />
        <Card name="缠论" verdict={chanVd}
          value={chanLast ? `末笔 ${chanLast.direction === 'up' ? '上' : '下'} · ${fmt(chanLast.endPrice)}` : '--'}
          note={chanSig || (chanLast ? `笔 ${fmt(chanLast.startPrice)} → ${fmt(chanLast.endPrice)}` : '需结构数据')} />
      </Section>

      <div className="px-3 pb-3 text-[11px] text-dark-300 border-t border-dark-700/40 pt-2">
        <span className="text-cyan-400 font-medium">读数：</span>{read}
      </div>
    </div>
  );
}

// 取最近一条缠论信号（买卖点）
function chanSignals(signals: { type: string; description: string }[]): string | null {
  if (!signals.length) return null;
  return signals[signals.length - 1].description;
}