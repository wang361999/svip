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
  calcMACD,
  calcKDJ,
  calcBollinger,
  calcVWAPArray,
  calcATRArray,
  detectFractals,
} from '@/shared/lib/indicators';

/**
 * 信号实证分级（口径：BTC/ETH × 4h/1d 各 1000 根，共 3920 观测，
 *  事件在 i 收盘确认、考核后 10 根方向命中，并做前/后半程稳定性检验。
 *  详见 scripts/backtest/all-signals-backtest.mts）
 *
 *  A 实证有效：跨前后两半 lift 同号且为正，计入顶部多空综合
 *  B 反向风险：信号一响往往是行情末端（lift 稳定为负），不投方向票，仅作"勿追"警示
 *  C 仅作参考：无稳定方向预测力（前后两半反转或趋零），不投方向票，只保留真实读数/结构位
 */
type Grade = 'A' | 'B' | 'C';
type Verdict = 'bull' | 'bear' | 'osc';

interface Item {
  key: string;
  name: string;
  verdict: Verdict;
  grade: Grade;
  value: string;      // 真实读数（绝不虚构）
  note?: string;      // 补充说明（来自真实数据 / 回测依据）
  pct?: number;       // 0~100 置信/偏度（可选）
}

const VERDICT_LABEL: Record<Verdict, string> = { bull: '多', bear: '空', osc: '中性' };

const GRADE_META: Record<Grade, { tag: string; chip: string; ring: string }> = {
  A: { tag: '实证', chip: '', ring: 'border-dark-700/50' }, // A 级 chip 用 verdict 配色（下方动态取）
  B: { tag: '反向风险', chip: 'bg-amber-500/15 border-amber-500/40 text-amber-400', ring: 'border-amber-500/30' },
  C: { tag: '参考', chip: 'bg-dark-700/30 border-dark-600/40 text-dark-400', ring: 'border-dark-700/40 opacity-80' },
};

const VERDICT_COLOR: Record<Verdict, { chip: string; text: string; bar: string }> = {
  bull: { chip: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400', text: 'text-emerald-400', bar: 'bg-emerald-500' },
  bear: { chip: 'bg-red-500/15 border-red-500/40 text-red-400', text: 'text-red-400', bar: 'bg-red-500' },
  osc: { chip: 'bg-amber-500/15 border-amber-500/40 text-amber-400', text: 'text-amber-400', bar: 'bg-amber-500' },
};

/** A 级信号计入多空综合的权重（回测 lift 越大权重越高） */
const A_WEIGHT: Record<string, number> = {
  divTop: 2.0,    // MACD/DIF 顶背离：lift +29.8pp，最锋利（样本 40，出现少）
  fractal: 1.5,   // 缠论分型顶/底：lift +18.2 / +10.3pp，样本 363/367 最扎实
  funding: 1.6,   // 资金费率逆向拥挤：外部独立情绪证据，另有专项实测
  ichimoku: 1.2,  // 收盘跌破云带：lift +5.5pp，仅看跌单边有效
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

const FUNDING_LEVEL: Record<string, string> = { none: '', mild: '轻度拥挤', strong: '明显拥挤', extreme: '极端拥挤' };
/** 分型/背离只承认右侧已走出 3 根、被确认的信号（strength=3） */
const FRACTAL_STRENGTH = 3;
/** 背离信号只在最近 N 根内确认才提示，避免陈旧信号 */
const DIV_RECENT_BARS = 20;

export default function SignalPanel({ klines, refreshKey, precision, symbol = 'ETHUSDT' }: Props) {
  const [funding, setFunding] = useState<FundingView | null>(null);

  // 外源资金费率：独立拉取，外部情绪证据（与价格类信号解耦）
  useEffect(() => {
    let alive = true;
    const load = async (sym: string) => {
      try {
        const resp = await fetch(`/api/futures-data?symbol=${sym}&period=1d&limit=500`);
        if (!resp.ok) { setFunding(null); return; }
        const j = await resp.json();
        const pts: FundingPoint[] | undefined = j?.funding;
        if (!pts || pts.length < 60) { setFunding(null); return; }
        const c = calcFundingCrowding(pts);
        if (!c) { setFunding(null); return; }
        setFunding({
          tilt: c.tilt,
          level: c.level,
          annualized: c.annualizedPct,
          z: c.z,
          current: c.currentRate,
        });
      } catch { setFunding(null); }
    };
    void load(symbol);
    return () => { alive = false; };
  }, [refreshKey, symbol]);

  const rows = useMemo<Item[]>(() => {
    void refreshKey;
    const n = klines.length;
    if (n < 70) return [];
    const last = klines[n - 1];
    const price = last.close;
    const priceFmt = (p: number | null | undefined) => fmtPrice(p, precision);
    const items: Item[] = [];

    // ============ A 级：实证有效（计入多空综合）============

    // ---- 缠论分型（最近一个已确认的顶/底分型）----
    const frac = detectFractals(klines, FRACTAL_STRENGTH);
    const confirmBound = n - 1 - FRACTAL_STRENGTH; // 分型右侧需 3 根确认
    const confirmedHighs = frac.fractalHighs.filter((f) => f.idx <= confirmBound);
    const confirmedLows = frac.fractalLows.filter((f) => f.idx <= confirmBound);
    const lastHigh = confirmedHighs[confirmedHighs.length - 1];
    const lastLow = confirmedLows[confirmedLows.length - 1];
    const latestFractal =
      lastHigh && lastLow
        ? lastHigh.idx >= lastLow.idx
          ? { kind: 'top' as const, f: lastHigh }
          : { kind: 'bottom' as const, f: lastLow }
        : lastHigh
        ? { kind: 'top' as const, f: lastHigh }
        : lastLow
        ? { kind: 'bottom' as const, f: lastLow }
        : null;
    if (latestFractal) {
      const barsAgo = n - 1 - latestFractal.f.idx;
      items.push(
        latestFractal.kind === 'top'
          ? {
              key: 'fractal', name: '缠论分型', grade: 'A', verdict: 'bear',
              value: `顶分型 · ${barsAgo}根前确认`,
              note: `H ${priceFmt(latestFractal.f.price)} · 回落风险（回测10根赢率65.8%，超额+18.2pp）`,
            }
          : {
              key: 'fractal', name: '缠论分型', grade: 'A', verdict: 'bull',
              value: `底分型 · ${barsAgo}根前确认`,
              note: `L ${priceFmt(latestFractal.f.price)} · 反弹支撑（回测10根赢率62.7%，超额+10.3pp）`,
            },
      );
    }

    // ---- MACD/DIF 背离（顶背离=A 级看跌；底背离前后半程反转，仅 C 级提示）----
    const macd = calcMACD(klines, 12, 26, 9);
    if (macd) {
      const highsAsc = [...confirmedHighs].sort((a, b) => a.idx - b.idx);
      if (highsAsc.length >= 2) {
        const a = highsAsc[highsAsc.length - 2];
        const b = highsAsc[highsAsc.length - 1];
        const da = macd.dif[a.idx], db = macd.dif[b.idx];
        if (da != null && db != null && klines[b.idx].close > klines[a.idx].close && db < da && n - 1 - b.idx <= DIV_RECENT_BARS) {
          items.push({
            key: 'divTop', name: 'MACD背离', grade: 'A', verdict: 'bear',
            value: `顶背离 · ${n - 1 - b.idx}根前确认`,
            note: `价创新高而DIF走低（回测10根赢率77.5%，超额+29.8pp，样本40）`,
          });
        }
      }
      const lowsAsc = [...confirmedLows].sort((a, b) => a.idx - b.idx);
      if (lowsAsc.length >= 2) {
        const a = lowsAsc[lowsAsc.length - 2];
        const b = lowsAsc[lowsAsc.length - 1];
        const da = macd.dif[a.idx], db = macd.dif[b.idx];
        if (da != null && db != null && klines[b.idx].close < klines[a.idx].close && db > da && n - 1 - b.idx <= DIV_RECENT_BARS) {
          items.push({
            key: 'divBottom', name: 'MACD背离', grade: 'C', verdict: 'osc',
            value: `底背离 · ${n - 1 - b.idx}根前`,
            note: '价创新低而DIF抬高；历史前后半程表现反转，可靠性弱，谨慎参考',
          });
        }
      }
    }

    // ---- 一目云带：跌破=A 级看跌；站上=B 级反向（勿追）；云内=C ----
    const ichi = calcIchimoku(klines, 9, 26, 52, 26);
    if (ichi && ichi.cloud.length) {
      // 当前位置的云带：用已收盘柱对应的云（cloud 数组含未来外推，需对齐时间）
      const curTime = last.time;
      const curCloud = [...ichi.cloud].reverse().find((c) => c.time <= curTime) ?? ichi.cloud[0];
      if (price < curCloud.bottom) {
        items.push({
          key: 'ichimoku', name: '一目云带', grade: 'A', verdict: 'bear',
          value: '收盘跌破云带',
          note: `云顶 ${priceFmt(curCloud.top)} · 云底 ${priceFmt(curCloud.bottom)}（回测超额+5.5pp，两段同向）`,
        });
      } else if (price > curCloud.top) {
        items.push({
          key: 'ichimoku', name: '一目云带', grade: 'B', verdict: 'osc',
          value: '收盘站上云带 · 勿追高',
          note: `云顶 ${priceFmt(curCloud.top)}；实测站上云带后超额 −7.0pp，处超买一侧`,
        });
      } else {
        items.push({
          key: 'ichimoku', name: '一目云带', grade: 'C', verdict: 'osc',
          value: '云内震荡',
          note: `云顶 ${priceFmt(curCloud.top)} · 云底 ${priceFmt(curCloud.bottom)}`,
        });
      }
    }

    // ---- 资金费率（外部情绪，逆向拥挤，专项实测）----
    if (funding) {
      const tiltText = funding.tilt === 'bear' ? '逆向·偏空(多单拥挤)' : funding.tilt === 'bull' ? '逆向·偏多(空单拥挤)' : '中性·无拥挤';
      items.push({
        key: 'funding', name: '资金费率·外源', grade: 'A',
        verdict: funding.tilt,
        value: `年化 ${fmt(funding.annualized, 2)}% · z=${fmt(funding.z, 2)}`,
        note: `${FUNDING_LEVEL[funding.level]}${tiltText}；|z|≥0.7 五日逆向命中 ETH70.7%/BTC59.1%，风控参考`,
      });
    }

    // ============ B 级：实测反向 / 末端风险（不投方向票）============

    // ---- 预测合成：转多稳定反向 → 风险提示；转空前后反转 → C ----
    const synth = calcPredictionSynth(klines);
    if (synth) {
      if (synth.direction === 'up') {
        items.push({
          key: 'synth', name: '预测合成', grade: 'B', verdict: 'osc',
          value: `合成器喊多 ${synth.confidence}%`,
          note: `${synth.signals[0]?.text ?? ''}；实测"转多"超额约−6pp且两段同向，警惕阶段见顶，勿跟单`,
          pct: synth.confidence,
        });
      } else {
        items.push({
          key: 'synth', name: '预测合成', grade: 'C',
          verdict: synth.direction === 'down' ? 'bear' : 'osc',
          value: `置信 ${synth.confidence}%`,
          note: `${synth.signals[0]?.text ?? '共振平缓'}；历史方向前后反转，仅参考`,
          pct: synth.confidence,
        });
      }
    }

    // ---- 九线测算：转多稳定反向 → 风险提示；转空/破坏 → C ----
    const ab9 = calcAB9Lines(klines);
    if (ab9) {
      const volNote = ab9.volumeRatio >= 1.15 ? '· 放量' : ab9.volumeRatio <= 0.85 ? '· 缩量' : '';
      if (ab9.direction === 'up' && ab9.strength !== '趋势破坏') {
        items.push({
          key: 'ab9', name: '九线测算', grade: 'B', verdict: 'osc',
          value: `九线转多 · ${ab9.strength}`,
          note: `上升波段${volNote}；实测"转多"超额约−6pp两段同向，勿据此追高`,
          pct: Math.min(95, Math.max(5, Math.round(Math.abs(ab9.slope) / (ab9.height / 24) * 50 + (ab9.volumeRatio >= 1 ? 12 : 0)))),
        });
      } else {
        items.push({
          key: 'ab9', name: '九线测算', grade: 'C',
          verdict: ab9.strength === '趋势破坏' ? 'osc' : 'bear',
          value: ab9.strength,
          note: `${ab9.direction === 'up' ? '上升' : '下降'}波段 · ${ab9.betweenLines}${volNote}；转空历史≈持平，仅参考`,
        });
      }
    }

    // ---- BOLL：冲上轨=B 级均值回归；其余 C ----
    const bb = calcBollinger(klines, 20);
    if (bb) {
      if (price > bb.upper) {
        items.push({
          key: 'boll', name: 'BOLL', grade: 'B', verdict: 'osc',
          value: '冲上轨 · 勿追',
          note: `上轨 ${priceFmt(bb.upper)}；实测升破上轨后超额 −6.7pp 两段同向，倾向回落`,
        });
      } else {
        items.push({
          key: 'boll', name: 'BOLL', grade: 'C',
          verdict: price < bb.lower ? 'bear' : 'osc',
          value: price < bb.lower ? '下轨下方' : '轨道内',
          note: `上 ${priceFmt(bb.upper)} · 中 ${priceFmt(bb.middle)} · 下 ${priceFmt(bb.lower)}`,
        });
      }
    }

    // ============ C 级：无稳定方向预测力（仅结构/读数参考，不计分）============

    // ---- 综合方向决策（结构+缠论+九线糅合）：回测多空双向前后反转 ----
    const dirSig = calcDirectionSignal(klines);
    if (dirSig) {
      const rr = dirSig.rewardRisk != null ? ` · 盈亏比 ${dirSig.rewardRisk.toFixed(2)}` : '';
      const stopTxt = dirSig.stop != null ? `止${priceFmt(dirSig.stop)}` : '止损--';
      const tgtTxt = dirSig.target != null ? `标${priceFmt(dirSig.target)}` : '目标--';
      items.push({
        key: 'dirSignal', name: '综合方向', grade: 'C',
        verdict: dirSig.decision === 'long' ? 'bull' : dirSig.decision === 'short' ? 'bear' : 'osc',
        value: `${dirSig.label}${rr}`,
        note: `${stopTxt}/${tgtTxt} · ${dirSig.basis}；该复合决策回测前后反转，不建议作方向依据，止盈止损位可参考`,
        pct: dirSig.confidence,
      });
    }

    // ---- 缠论：最近笔方向本身无 edge，仅展示笔/中枢/买卖点计数 ----
    const chan = calcChan(klines);
    if (chan && chan.bis.length) {
      const lastBi = chan.bis[chan.bis.length - 1];
      items.push({
        key: 'chan', name: '缠论结构', grade: 'C',
        verdict: lastBi.direction === 'up' ? 'bull' : 'bear',
        value: lastBi.direction === 'up' ? '最近笔向上' : '最近笔向下',
        note: `笔${chan.bis.length} · 中枢${chan.zhongshus.length}${chan.signals.length ? ` · 买卖点信号${chan.signals.length}个(样本少待验证)` : ''}；方向以分型/背离为准`,
      });
    }

    // ---- KDJ：金死叉回测≈持平 ----
    const kdj = calcKDJ(klines, 9, 3, 3);
    if (kdj) {
      items.push({
        key: 'kdj', name: 'KDJ', grade: 'C',
        verdict: kdj.lastK >= kdj.lastD ? 'bull' : 'bear',
        value: `K ${fmt(kdj.lastK)} · D ${fmt(kdj.lastD)}`,
        note: kdj.lastJ >= 100 ? 'J超买' : kdj.lastJ <= 0 ? 'J超卖' : '正常；金死叉回测≈持平',
        pct: kdj.lastK,
      });
    }

    // ---- VWAP：仅成本参考 ----
    const vwapArr = calcVWAPArray(klines);
    const vwapLast = vwapArr[vwapArr.length - 1];
    if (vwapLast != null) {
      items.push({
        key: 'vwap', name: 'VWAP', grade: 'C',
        verdict: price > vwapLast ? 'bull' : 'bear',
        value: price > vwapLast ? '价格在均线上方' : '价格在均线下方',
        note: `VWAP ${priceFmt(vwapLast)}（成交成本参考，非方向信号）`,
      });
    }

    // ---- 趋势通道：纯画线 ----
    const tc = calcTrendChannel(klines, 60);
    if (tc) {
      items.push({
        key: 'trendChannel', name: '趋势通道', grade: 'C',
        verdict: tc.direction === 'up' ? 'bull' : tc.direction === 'down' ? 'bear' : 'osc',
        value: tc.direction === 'up' ? '上行通道' : tc.direction === 'down' ? '下行通道' : '走平',
        note: `斜率 ${tc.slope.toFixed(6)} · 宽 ${tc.widthPct}%（几何通道，沿轨道高抛低吸参考）`,
      });
    }

    // ---- 价值区域：纯成交密集区 ----
    const va = calcValueArea(klines, 80);
    if (va) {
      items.push({
        key: 'valueArea', name: '价值区域', grade: 'C',
        verdict: price > va.vah ? 'bull' : price < va.val ? 'bear' : 'osc',
        value: price > va.vah ? 'VAH上方' : price < va.val ? 'VAL下方' : '价值区内',
        note: `POC ${priceFmt(va.poc)}（成交密集区，支撑阻力参考）`,
      });
    }

    // ---- ATR：波动，不判方向 ----
    const atr = calcATRArray(klines, 14);
    const atrLast = atr[atr.length - 1];
    if (atrLast != null) {
      items.push({
        key: 'atr', name: 'ATR', grade: 'C', verdict: 'osc',
        value: `波动 ${fmt(atrLast)}`,
        note: '波动率（不判方向），用于仓位与止损宽度',
      });
    }

    return items;
  }, [klines, refreshKey, precision, funding]);

  // 顶部多空综合：只统计 A 级（实证）信号；B/C 不投票
  const aRows = useMemo(() => rows.filter((r) => r.grade === 'A'), [rows]);
  const bRows = useMemo(() => rows.filter((r) => r.grade === 'B'), [rows]);

  const weighted = useMemo(() => {
    if (!aRows.length) return null;
    let b = 0, s = 0;
    for (const r of aRows) {
      const w = A_WEIGHT[r.key] ?? 1;
      if (r.verdict === 'bull') b += w;
      else if (r.verdict === 'bear') s += w;
    }
    const tot = b + s;
    if (!tot) return null;
    const bullRatio = b / tot;
    return {
      bullRatio,
      verdict: bullRatio > 0.6 ? 'bull' : bullRatio < 0.4 ? 'bear' : 'osc',
    };
  }, [aRows]);

  const Card = ({ r }: { r: Item }) => {
    const gm = GRADE_META[r.grade];
    const vc = VERDICT_COLOR[r.verdict];
    const chipCls = r.grade === 'A' ? vc.chip : gm.chip;
    const chipText = r.grade === 'A' ? VERDICT_LABEL[r.verdict] : gm.tag;
    return (
      <div className={`rounded-lg border ${gm.ring} bg-dark-800/40 p-2.5 flex flex-col gap-1.5`}>
        <div className="flex items-center justify-between gap-1">
          <span className="text-[11px] text-dark-200 font-medium truncate">{r.name}</span>
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${chipCls}`}>
            {chipText}
          </span>
        </div>
        <div className={`text-[11px] font-mono tabular-nums leading-tight ${r.grade === 'A' ? vc.text : 'text-dark-300'}`}>
          {r.value}
        </div>
        {r.note ? <div className="text-[10px] text-dark-400 leading-tight break-words">{r.note}</div> : null}
        {r.pct != null && r.grade === 'A' ? (
          <div className="mt-auto pt-0.5">
            <div className="h-1 w-full rounded-full overflow-hidden bg-dark-700/40">
              <div className={`h-full rounded-full ${vc.bar}`} style={{ width: `${Math.max(3, Math.min(100, r.pct))}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const Section = ({ title, list, accent }: { title: string; list: Item[]; accent?: string }) =>
    list.length ? (
      <div>
        <div className={`px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider ${accent ?? 'text-dark-500'}`}>{title}</div>
        <div className="grid grid-cols-2 gap-2 px-3 pb-3">
          {list.map((r) => <Card key={r.key} r={r} />)}
        </div>
      </div>
    ) : null;

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dark-700/60 bg-dark-800/30 px-4 py-3 text-xs text-dark-400">
        信号 · 等待K线数据…
      </div>
    );
  }

  const cRows = rows.filter((r) => r.grade === 'C');

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-dark-800/30 overflow-hidden">
      {/* 汇总头：多空综合只由 A 级实证信号决定 */}
      <div className="flex items-center gap-2 flex-wrap px-3 pt-2.5 pb-1 border-b border-dark-700/40">
        <span className="text-xs font-semibold text-slate-200">信号</span>
        {weighted ? (
          <>
            <div className="flex h-1.5 w-28 rounded-full overflow-hidden">
              <div className="bg-emerald-500" style={{ width: `${weighted.bullRatio * 100}%` }} />
              <div className="bg-red-500" style={{ width: `${(1 - weighted.bullRatio) * 100}%` }} />
            </div>
            <span className={`text-[10px] font-semibold ${weighted.verdict === 'bull' ? 'text-emerald-400' : weighted.verdict === 'bear' ? 'text-red-400' : 'text-amber-400'}`}>
              {weighted.verdict === 'bull'
                ? `实证偏多 ${Math.round(weighted.bullRatio * 100)}%`
                : weighted.verdict === 'bear'
                ? `实证偏空 ${Math.round((1 - weighted.bullRatio) * 100)}%`
                : '实证中性'}
            </span>
          </>
        ) : (
          <span className="text-[10px] text-dark-500">暂无 A 级实证信号</span>
        )}
        {bRows.length > 0 && (
          <span className="text-[10px] font-semibold text-amber-400">⚠ {bRows.length} 项末端风险</span>
        )}
        <span className="text-[10px] text-dark-500 ml-auto">
          分级依据：BTC/ETH 4h+1d 共3920样本回测 · 多空综合仅计「实证」
        </span>
      </div>

      <Section
        title="实证信号 · 回测跨行情有效（计入多空综合）"
        list={aRows}
        accent="text-emerald-400/80"
      />
      <Section
        title="末端风险 · 实测反向（勿追，不计分）"
        list={bRows}
        accent="text-amber-400/90"
      />
      <Section
        title="结构 / 指标参考 · 无稳定方向预测力（不计分）"
        list={cRows}
      />
    </div>
  );
}
