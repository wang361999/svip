'use client';

import { useEffect, useMemo, useState } from 'react';
import { KlineData } from '@/shared/lib/market-data';

import { calcFundingCrowding, FundingPoint } from '@/shared/lib/futures-signal';
import {
  calcTrendChannel,
  calcValueArea,
  calcIchimoku,
  calcPredictionSynth,
  calcAB9Lines,
  calcDirectionSignal,
  calcChan,
  calcEMAArray,
  calcMACD,
  calcRSIArray,
  calcKDJ,
  calcBollinger,
  calcVWAPArray,
  calcATRArray,
} from '@/shared/lib/indicators';

type Verdict = 'bull' | 'bear' | 'osc';

interface Item {
  key: string;
  name: string;
  verdict: Verdict;
  value: string;      // 真实读数（绝不虚构）
  note?: string;      // 补充说明（来自真实数据）
  pct?: number;       // 0~100 置信/偏度（可选）
}

const VERDICT_LABEL: Record<Verdict, string> = { bull: '多', bear: '空', osc: '震荡' };
const FUNDING_LEVEL: Record<string, string> = { none: '', mild: '轻度拥挤', strong: '明显拥挤', extreme: '极端拥挤' };
const VERDICT_COLOR: Record<Verdict, { chip: string; text: string; bar: string; barBg: string }> = {
  bull: {
    chip: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400',
    text: 'text-emerald-400',
    bar: 'bg-emerald-500',
    barBg: 'bg-emerald-500/10',
  },
  bear: {
    chip: 'bg-red-500/15 border-red-500/40 text-red-400',
    text: 'text-red-400',
    bar: 'bg-red-500',
    barBg: 'bg-red-500/10',
  },
  osc: {
    chip: 'bg-amber-500/15 border-amber-500/40 text-amber-400',
    text: 'text-amber-400',
    bar: 'bg-amber-500',
    barBg: 'bg-amber-500/10',
  },
};

function fmt(v: number | null | undefined, n = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return Number(v).toFixed(n);
}

function fmtPrice(v: number | null | undefined, precision: number): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return Number(v).toFixed(Math.max(1, Math.min(8, precision)));
}

interface Props {
  klines: KlineData[];
  refreshKey: number;
  precision: number;
  symbol?: string;
}

interface FundingView {
  tilt: 'bull' | 'bear' | 'osc';
  level: string;
  annualized: number;
  z: number;
  current: number;
}

export default function SignalPanel({ klines, refreshKey, precision, symbol = 'ETHUSDT' }: Props) {
  const [funding, setFunding] = useState<FundingView | null>(null);
  const [fFund, setFFund] = useState<FundingView | null>(null);

  // 外源资金费率：独立拉取（ETH/USDT、BTC/USDT），用于资金面视角，绝不影响价格类判定
  useEffect(() => {
    let alive = true;
    const load = async (sym: string, setter: (v: FundingView | null) => void) => {
      try {
        const resp = await fetch(`/api/futures-data?symbol=${sym}&period=1d&limit=500`);
        if (!resp.ok) { setter(null); return; }
        const j = await resp.json();
        const pts: FundingPoint[] | undefined = j?.funding;
        if (!pts || pts.length < 60) { setter(null); return; }
        const c = calcFundingCrowding(pts);
        if (!c) { setter(null); return; }
        setter({
          tilt: c.tilt,
          level: c.level,
          annualized: c.annualizedPct,
          z: c.z,
          current: c.currentRate,
        });
      } catch { setter(null); }
    };
    void load(symbol, setFunding);
    void load(symbol.includes('BTC') ? 'ETHUSDT' : 'BTCUSDT', setFFund);
    return () => { alive = false; };
  }, [refreshKey, symbol]);

  const rows = useMemo<Item[]>(() => {
    void refreshKey; // 触发重算：tick 版本号变化时刷新面板
    const n = klines.length;
    if (n < 5) return [];
    const last = klines[n - 1];
    const price = last.close;
    const priceFmt = (p: number | null | undefined) => fmtPrice(p, precision);
    const items: Item[] = [];

    // ---- 当前方向（结构顺趋势为主；盈亏比优先；仅建议，不含带单承诺） ----
    const dirSig = calcDirectionSignal(klines);
    if (dirSig) {
      const dv: Verdict = dirSig.decision === 'long' ? 'bull' : dirSig.decision === 'short' ? 'bear' : 'osc';
      const rr = dirSig.rewardRisk != null ? ` · 盈亏比 ${dirSig.rewardRisk.toFixed(2)}` : '';
      const stopTxt = dirSig.stop != null ? `止${fmtPrice(dirSig.stop, precision)}` : '止损--';
      const tgtTxt = dirSig.target != null ? `标${fmtPrice(dirSig.target, precision)}` : '目标--';
      const shortWarn = dirSig.decision === 'short' ? ' · 空头置信偏低' : '';
      items.push({
        key: 'dirSignal', name: '当前方向', verdict: dv,
        value: `${dirSig.label}${rr}${shortWarn}`,
        note: `${stopTxt}/${tgtTxt} · 趋势${dirSig.trendLabel} · ${dirSig.basis}`,
        pct: dirSig.confidence,
      });
    }

    // ---- 趋势通道 ----
    const tc = calcTrendChannel(klines, 60);
    if (tc) {
      items.push({
        key: 'trendChannel', name: '趋势通道',
        verdict: tc.direction === 'up' ? 'bull' : tc.direction === 'down' ? 'bear' : 'osc',
        value: tc.direction === 'up' ? '上行通道' : tc.direction === 'down' ? '下行通道' : '走平',
        note: `斜率 ${tc.slope.toFixed(6)} · 宽 ${tc.widthPct}%`,
      });
    }

    // ---- 预测信号合成 ----
    const synth = calcPredictionSynth(klines);
    if (synth) {
      items.push({
        key: 'synth', name: '预测合成',
        verdict: synth.direction === 'up' ? 'bull' : synth.direction === 'down' ? 'bear' : 'osc',
        value: `置信 ${synth.confidence}%`,
        note: synth.signals[0] ? synth.signals[0].text : '共振平缓',
        pct: synth.confidence,
      });
    }

    // ---- 一目均衡表 ----
    const ichi = calcIchimoku(klines, 9, 26, 52, 26);
    if (ichi && ichi.cloud.length) {
      const lastCloud = ichi.cloud[ichi.cloud.length - 1];
      const cloudTop = lastCloud.top;
      const cloudBot = lastCloud.bottom;
      const inside = price <= cloudTop && price >= cloudBot;
      items.push({
        key: 'ichimoku', name: '一目均衡',
        verdict: inside ? 'osc' : price > cloudTop ? 'bull' : 'bear',
        value: inside ? '云内观望' : price > cloudTop ? '云上方（多）' : '云下方（空）',
        note: `云顶 ${priceFmt(cloudTop)} · 云底 ${priceFmt(cloudBot)}`,
      });
    }

    // ---- 价值区域 ----
    const va = calcValueArea(klines, 80);
    if (va) {
      const above = price > va.vah;
      const below = price < va.val;
      items.push({
        key: 'valueArea', name: '价值区域',
        verdict: above ? 'bull' : below ? 'bear' : 'osc',
        value: above ? '上穿价值区上沿' : below ? '跌破价值区下沿' : '价值区内',
        note: `POC ${priceFmt(va.poc)}`,
      });
    }

    // ---- AB9线 ----
    const ab9 = calcAB9Lines(klines);
    if (ab9) {
      const broken = ab9.strength === '趋势破坏';
      // 挑出最近的关键穿越（中轴/破坏区优先）
      const keyCross = ab9.cross.find(c => c.dir === 'down' && c.lineNo <= 4)
        || ab9.cross.find(c => c.dir === 'up' && c.lineNo >= 8);
      const volNote = ab9.volumeRatio >= 1.15 ? '· 放量' : ab9.volumeRatio <= 0.85 ? '· 缩量' : '';
      items.push({
        key: 'ab9', name: 'AB9线',
        verdict: broken ? 'osc' : ab9.direction === 'up' ? 'bull' : 'bear',
        value: keyCross
          ? `${keyCross.dir === 'up' ? '升破' : '跌破'}${keyCross.lineNo}线(${keyCross.label})`
          : ab9.strength,
        note: `${ab9.direction === 'up' ? '上升' : '下降'}波段 · ${ab9.betweenLines}${volNote}`,
        pct: Math.min(95, Math.max(5, Math.round(Math.abs(ab9.slope) / (ab9.height / 24) * 50 + (ab9.volumeRatio >= 1 ? 12 : 0)))),
      });
    }

    // ---- 缠论 ----
    const chan = calcChan(klines);
    if (chan && chan.bis.length) {
      const lastBi = chan.bis[chan.bis.length - 1];
      const lastSignal = chan.signals[chan.signals.length - 1];
      items.push({
        key: 'chan', name: '缠论',
        verdict: lastBi.direction === 'up' ? 'bull' : 'bear',
        value: lastBi.direction === 'up' ? '最近笔向上' : '最近笔向下',
        note: lastSignal ? `${lastSignal.type === 'firstBuy' ? '一买' : lastSignal.type === 'secondBuy' ? '二买' : lastSignal.type === 'thirdBuy' ? '三买' : lastSignal.type === 'firstSell' ? '一卖' : lastSignal.type === 'secondSell' ? '二卖' : '三卖'} @ ${priceFmt(lastSignal.price)}` : `笔${chan.bis.length} · 中枢${chan.zhongshus.length}`,
      });
    }

    // ---- KDJ ----
    const kdj = calcKDJ(klines, 9, 3, 3);
    if (kdj) {
      items.push({
        key: 'kdj', name: 'KDJ',
        verdict: kdj.lastK >= kdj.lastD ? 'bull' : 'bear',
        value: `K ${fmt(kdj.lastK)} · D ${fmt(kdj.lastD)}`,
        note: kdj.lastJ >= 100 ? 'J超买' : kdj.lastJ <= 0 ? 'J超卖' : '正常',
        pct: kdj.lastK,
      });
    }

    // ---- BOLL ----
    const bb = calcBollinger(klines, 20);
    if (bb) {
      let v: Verdict = 'osc'; let txt = '';
      if (price > bb.upper) { v = 'bull'; txt = '上轨上方'; }
      else if (price < bb.lower) { v = 'bear'; txt = '下轨下方'; }
      else { v = 'osc'; txt = '轨道内'; }
      items.push({
        key: 'boll', name: 'BOLL',
        verdict: v,
        value: txt,
        note: `上 ${priceFmt(bb.upper)} · 中 ${priceFmt(bb.middle)} · 下 ${priceFmt(bb.lower)}`,
      });
    }

    // ---- VWAP ----
    const vwapArr = calcVWAPArray(klines);
    const vwapLast = vwapArr[vwapArr.length - 1];
    if (vwapLast != null) {
      items.push({
        key: 'vwap', name: 'VWAP',
        verdict: price > vwapLast ? 'bull' : 'bear',
        value: price > vwapLast ? '价格在上方' : '价格在下方',
        note: `VWAP ${priceFmt(vwapLast)}`,
      });
    }

    // ---- ATR（波动，非方向）----
    const atr = calcATRArray(klines, 14);
    const atrLast = atr[atr.length - 1];
    if (atrLast != null) {
      items.push({
        key: 'atr', name: 'ATR', verdict: 'osc',
        value: `波动 ${fmt(atrLast)}`,
        note: '波动率指示（不判方向）',
      });
    }

    // ---- 资金费率（外部非价格数据，逆向拥挤，已实测验证）----
    if (funding) {
      const tiltText = funding.tilt === 'bear' ? '逆向·偏空(多单拥挤)' : funding.tilt === 'bull' ? '逆向·偏多(空单拥挤)' : '中性·无拥挤';
      items.push({
        key: 'funding', name: '资金费率·外源',
        verdict: funding.tilt,
        value: `年化 ${fmt(funding.annualized, 2)}% · z=${fmt(funding.z, 2)}`,
        note: `${FUNDING_LEVEL[funding.level]}${tiltText}；实测|z|≥0.7 五日逆向命中：ETH70.7%/BTC59.1%，样本58/66，仅风控参考`,
      });
    }

    return items;
  }, [klines, refreshKey, precision, funding, fFund]);

  const counts = useMemo(() => {
    const c = { bull: 0, bear: 0, osc: 0 };
    for (const r of rows) c[r.verdict]++;
    return c;
  }, [rows]);

  const total = rows.length || 1;
  const bullPct = (counts.bull / total) * 100;
  const bearPct = (counts.bear / total) * 100;

  const Section = ({ title, list }: { title: string; list: Item[] }) => (
    <div>
      <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-dark-500">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 px-3 pb-3">
        {list.map((r) => {
          const c = VERDICT_COLOR[r.verdict];
          return (
            <div key={r.key} className="rounded-lg border border-dark-700/50 bg-dark-800/40 p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="text-[11px] text-dark-200 font-medium truncate">{r.name}</span>
                <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${c.chip} ${c.text}`}>
                  {VERDICT_LABEL[r.verdict]}
                </span>
              </div>
              <div className="text-[11px] font-mono tabular-nums text-dark-300 leading-tight">{r.value}</div>
              {r.note ? <div className="text-[10px] text-dark-400 leading-tight break-words">{r.note}</div> : null}
              {r.pct != null ? (
                <div className="mt-auto pt-0.5">
                  <div className="h-1 w-full rounded-full overflow-hidden bg-dark-700/40">
                    <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${Math.max(3, Math.min(100, r.pct))}%` }} />
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="border-b border-dark-700/50 px-4 py-3 text-xs text-dark-400">
        信号面板 · 等待K线数据…
      </div>
    );
  }

  const drawTools = rows.filter((r) => ['trendChannel', 'pitchfork', 'composite', 'synth', 'ichimoku', 'valueArea', 'ab9', 'chan'].includes(r.key));
  const coreInds = rows.filter((r) => !['trendChannel', 'pitchfork', 'composite', 'synth', 'ichimoku', 'valueArea', 'ab9', 'chan', 'atr'].includes(r.key));

  // 加权综合：回测实证（BTC/ETH 4h+1d 组合）——多头信号重、空头降权(多空不对称)、资金费率逆向高优
  const weighted = useMemo(() => {
    if (!rows.length) return null;
    const w = (r: Item) => (r.key === 'funding' ? 1.6 : r.verdict === 'bull' ? 1.0 : r.verdict === 'bear' ? 0.6 : 0.3);
    let b = 0, s = 0;
    for (const r of rows) { if (r.verdict === 'bull') b += w(r); else if (r.verdict === 'bear') s += w(r); }
    const tot = b + s;
    if (!tot) return null;
    const bullRatio = b / tot;
    return { bullRatio, verdict: bullRatio > 0.58 ? 'bull' : bullRatio < 0.42 ? 'bear' : 'osc', hasFunding: rows.some((r) => r.key === 'funding') };
  }, [rows]);

  return (
    <div className="border-b border-dark-700/50 bg-dark-900/60">
      {/* 汇总头 */}
      <div className="flex items-center gap-3 flex-wrap px-3 pt-2">
        <span className="text-xs font-semibold text-slate-200">信号面板</span>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="flex items-center gap-1 text-emerald-400"><i className="w-1.5 h-1.5 rounded-full bg-emerald-400" />多 {counts.bull}</span>
          <span className="flex items-center gap-1 text-red-400"><i className="w-1.5 h-1.5 rounded-full bg-red-400" />空 {counts.bear}</span>
          <span className="flex items-center gap-1 text-amber-400"><i className="w-1.5 h-1.5 rounded-full bg-amber-400" />震荡 {counts.osc}</span>
        </div>
        {/* 多空比例条（加权） */}
        <div className="flex h-1.5 w-28 rounded-full overflow-hidden">
          <div className="bg-emerald-500" style={{ width: `${weighted ? weighted.bullRatio * 100 : bullPct}%` }} />
          <div className="bg-red-500" style={{ width: `${weighted ? (1 - weighted.bullRatio) * 100 : bearPct}%` }} />
        </div>
        <span className={`text-[10px] font-semibold ${weighted ? (weighted.verdict === 'bull' ? 'text-emerald-400' : weighted.verdict === 'bear' ? 'text-red-400' : 'text-amber-400') : 'text-dark-500'}`}>
          {weighted
            ? `${weighted.verdict === 'bull' ? '加权·偏多' : weighted.verdict === 'bear' ? '加权·偏空' : '加权·中性'} ${Math.round(weighted.verdict === 'bear' ? (1 - weighted.bullRatio) * 100 : weighted.bullRatio * 100)}%`
            : '--'}
        </span>
        <span className="text-[10px] text-dark-500">
          {weighted && weighted.hasFunding ? `多期望>空(回测)·资金费率高优` : weighted ? `多头期望回报优于空头(4数据集回测)` : ``}
        </span>
      </div>

      <Section title="画线工具 · 结构判定" list={drawTools} />
      <Section title="核心指标 · 动量判定" list={coreInds} />
    </div>
  );
}