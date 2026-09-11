'use client';

import { useEffect, useMemo, useState } from 'react';
import { KlineData } from '@/shared/lib/market-data';

import { calcFundingCrowding, FundingPoint } from '@/shared/lib/futures-signal';
import {
  calcValueArea,
  calcIchimoku,
  calcPredictionSynth,
  calcAB9Lines,
  calcMACD,
  calcBollinger,
  calcATRArray,
  calcRSIArray,
  calcEMAArray,
  detectFractals,
} from '@/shared/lib/indicators';

/**
 * 交易决策卡
 * 只输出回测实证有用的东西：A 级信号投票定方向，B 级信号提示「勿追」，
 * 再用真实结构位（分型/云带/价值区域/布林）+ ATR 算出入场/止损/目标/仓位。
 * 口径：BTC/ETH × 4h/1d 共 3920 样本，详见 scripts/backtest/all-signals-backtest.mts
 */

type Vote = 'long' | 'short';
type Action = 'long' | 'long-pullback' | 'short' | 'wait';

interface Evidence {
  vote?: Vote;      // A 级实证：参与方向投票
  weight?: number;
  text: string;     // 大白话
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
}

const FRACTAL_STRENGTH = 3;
const DIV_RECENT_BARS = 20;
/** 单笔愿意承担的账户风险（%），仓位 = 该值 / 止损距离% */
const RISK_PER_TRADE = 2;

const ACTION_META: Record<Action, { label: string; chip: string; bar: string; text: string }> = {
  long: {
    label: '偏多 · 可做多',
    chip: 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300',
    bar: 'bg-emerald-500',
    text: 'text-emerald-300',
  },
  'long-pullback': {
    label: '偏多 · 等回踩再买',
    chip: 'bg-amber-500/15 border-amber-500/50 text-amber-300',
    bar: 'bg-amber-500',
    text: 'text-amber-300',
  },
  short: {
    label: '偏空 · 可做空',
    chip: 'bg-red-500/15 border-red-500/50 text-red-300',
    bar: 'bg-red-500',
    text: 'text-red-300',
  },
  wait: {
    label: '中性 · 观望',
    chip: 'bg-dark-700/50 border-dark-600 text-dark-300',
    bar: 'bg-dark-500',
    text: 'text-dark-300',
  },
};

function fmtPrice(v: number | null | undefined, precision: number): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '--';
  return Number(v).toFixed(Math.max(1, Math.min(8, precision)));
}

export default function SignalPanel({ klines, refreshKey, precision, symbol = 'ETHUSDT' }: Props) {
  const [funding, setFunding] = useState<FundingView | null>(null);

  // 外源资金费率：独立情绪证据（与价格类信号解耦）
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
        setFunding({ tilt: c.tilt, level: c.level, annualized: c.annualizedPct, z: c.z });
      } catch { setFunding(null); }
    };
    void load(symbol);
    return () => { alive = false; };
  }, [refreshKey, symbol]);

  const model = useMemo(() => {
    void refreshKey;
    const n = klines.length;
    if (n < 70) return null;
    const pf = (p: number | null | undefined) => fmtPrice(p, precision);

    const last = klines[n - 1];
    const price = last.close;

    const pros: Evidence[] = [];   // A 级实证依据（无前视口径：确认根入场）
    const warns: string[] = [];    // B 级末端风险（不投票，只提示勿追）
    const notes: string[] = [];    // 结构参考（不投票）
    const supCand: number[] = [];  // 支撑候选价
    const resCand: number[] = [];  // 阻力候选价

    // 周期识别（多个新信号只在特定周期有效，回测确认不可跨周期乱用）
    const barMs = n >= 2 ? klines[1].time - klines[0].time : 0;
    const is4h = barMs === 4 * 3600 * 1000;
    const is1d = barMs === 24 * 3600 * 1000;
    const bb = calcBollinger(klines, 20);

    // ---- 分型：无前视复核后顶分型仅小幅优势(权重降到1.0)；底分型前后反转，降级为纯结构参考 ----
    const frac = detectFractals(klines, FRACTAL_STRENGTH);
    const confirmBound = n - 1 - FRACTAL_STRENGTH;
    const confirmedHighs = frac.fractalHighs.filter((f) => f.idx <= confirmBound);
    const confirmedLows = frac.fractalLows.filter((f) => f.idx <= confirmBound);
    const lastHigh = confirmedHighs[confirmedHighs.length - 1];
    const lastLow = confirmedLows[confirmedLows.length - 1];
    if (lastLow) supCand.push(lastLow.price);
    if (lastHigh) resCand.push(lastHigh.price);
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
      if (latestFractal.kind === 'top') {
        pros.push({ vote: 'short', weight: 1.0, text: `冲高回落结构（顶分型 ${pf(latestFractal.f.price)}，${barsAgo}根前确认）：确认后10根偏弱约51%，优势不大但方向稳定，作辅助票` });
      } else {
        notes.push(`近期有底分型 ${pf(latestFractal.f.price)}（${barsAgo}根前确认）：实测抄底胜率不稳定，不投多票，只把它当支撑位参考`);
      }
    }

    // ---- A 级：MACD DIF 顶背离（无前视复核：确认后10根下跌率62.5%，lift+14.8pp，两段稳定）----
    const macd = calcMACD(klines, 12, 26, 9);
    if (macd) {
      const highsAsc = [...confirmedHighs].sort((a, b) => a.idx - b.idx);
      if (highsAsc.length >= 2) {
        const a = highsAsc[highsAsc.length - 2];
        const b = highsAsc[highsAsc.length - 1];
        const da = macd.dif[a.idx];
        const db = macd.dif[b.idx];
        if (da != null && db != null && klines[b.idx].close > klines[a.idx].close && db < da && n - 1 - b.idx <= DIV_RECENT_BARS) {
          pros.push({ vote: 'short', weight: 2.0, text: `价格创新高但上涨动能减弱（MACD顶背离，${n - 1 - b.idx}根前确认）：确认后10根下跌概率62.5%，是目前最稳的见顶信号` });
        }
      }
    }

    // ---- A 级（4h 限定）：RSI 顶背离·超买区（lift+19.8pp，两段+19/+20 稳定，n=58）----
    if (is4h) {
      const rsiArr = calcRSIArray(klines, 14);
      const i = n - 1;
      const rNow = rsiArr[i];
      if (rNow != null && i >= 70) {
        const s1 = i - 5, s0 = i - 12;
        const h1 = Math.max(...klines.slice(s1, i + 1).map((x) => x.high));
        const h0 = Math.max(...klines.slice(s0, s1).map((x) => x.high));
        const rh1 = Math.max(...rsiArr.slice(s1, i + 1).filter((x): x is number => x != null));
        const rh0 = Math.max(...rsiArr.slice(s0, s1).filter((x): x is number => x != null));
        if (isFinite(h0) && isFinite(rh0) && h1 > h0 && rh1 < rh0 - 2 && rNow > 55) {
          pros.push({ vote: 'short', weight: 1.8, text: `价格还在涨但 RSI 已经顶不住（RSI顶背离，当前${rNow.toFixed(0)}）：4h周期确认后10根下跌率约66%，比顶分型更早预警` });
        }
        // ---- A 级（4h 限定）：缩量止跌（lift+15.5pp，两段+12/+19 稳定，n=66）----
        const ema20Arr = calcEMAArray(klines, 20);
        const k0 = klines[i];
        let volSum = 0;
        for (let j = i - 19; j <= i; j++) volSum += klines[j].volume;
        const volMa = volSum / 20;
        if (k0.close < ema20Arr[i] && k0.volume < 0.6 * volMa && k0.low > klines[i - 1].low && k0.close < klines[i - 3].close) {
          pros.push({ vote: 'long', weight: 1.3, text: `下跌中成交量缩到均量6成以下且价格不再创新低（抛压枯竭）：4h周期确认后10根上涨率约70%，是较早的企稳提示` });
        }
      }

      // ---- 避雷（4h 限定）：波动率收缩后的突破多为假突破（向上lift-21.8pp/向下-16.6pp，两段稳定）----
      if (bb) {
        const bw: number[] = [];
        for (let j = 0; j < n; j++) {
          const u = bb.upperSeries[j - 19]?.value;
          const l = bb.lowerSeries[j - 19]?.value;
          const md = bb.middleSeries[j - 19]?.value;
          bw.push(u != null && l != null && md ? (u - l) / md : NaN);
        }
        let squeeze = false;
        let since = -1;
        let breakDir: 'up' | 'down' | null = null;
        let breakAgo = 99;
        for (let j = 60; j < n; j++) {
          if (!isFinite(bw[j])) continue;
          let cnt = 0, tot = 0;
          for (let q = Math.max(0, j - 59); q <= j; q++) { if (isFinite(bw[q])) { tot++; if (bw[q] <= bw[j]) cnt++; } }
          if (tot && cnt / tot <= 0.2) { squeeze = true; since = j; }
          if (squeeze && j - since <= 5) {
            const hh = Math.max(...klines.slice(j - 20, j).map((x) => x.high));
            const ll = Math.min(...klines.slice(j - 20, j).map((x) => x.low));
            if (klines[j].close > hh) { breakDir = 'up'; breakAgo = n - 1 - j; squeeze = false; }
            else if (klines[j].close < ll) { breakDir = 'down'; breakAgo = n - 1 - j; squeeze = false; }
          }
        }
        if (breakDir && breakAgo <= 3) {
          warns.push(`刚发生"盘整收缩后${breakDir === 'up' ? '向上' : '向下'}突破"——4h周期这种突破历史上多数是假突破（向上追多少亏21.8%优势），别追，等回踩确认`);
        }
      }
    }

    // ---- A 级（1d 限定）：流星线·涨后长上影（lift+10.8pp，两段+7.6/+12.4 稳定，n=63）----
    if (is1d) {
      const k0 = klines[n - 1];
      const body = Math.abs(k0.close - k0.open);
      const rng = Math.max(1e-12, k0.high - k0.low);
      const upperW = k0.high - Math.max(k0.close, k0.open);
      const lowerW = Math.min(k0.close, k0.open) - k0.low;
      if (k0.close > klines[n - 4].close && upperW >= 2 * body && lowerW <= 0.25 * rng && body > 0) {
        pros.push({ vote: 'short', weight: 1.2, text: `日线上涨后收出长上影流星线（冲高被砸回）：日线确认后10根下跌率约60%，是较早的日线见顶提示` });
      }
    }

    // ---- A 级：一目云带（跌破有效；站上反而勿追，归 B 级）----
    let cloudBottom: number | null = null;
    let cloudTop: number | null = null;
    const ichi = calcIchimoku(klines, 9, 26, 52, 26);
    if (ichi && ichi.cloud.length) {
      const curCloud = [...ichi.cloud].reverse().find((c) => c.time <= last.time) ?? ichi.cloud[0];
      cloudTop = curCloud.top;
      cloudBottom = curCloud.bottom;
      supCand.push(cloudBottom);
      resCand.push(cloudTop);
      if (price < curCloud.bottom) {
        pros.push({ vote: 'short', weight: 1.2, text: `价格跌到云带（趋势支撑区）下方，云底 ${pf(curCloud.bottom)} 失守：历史后续偏弱` });
      } else if (price > curCloud.top) {
        warns.push(`价格涨到云带上方（云顶 ${pf(curCloud.top)}），历史此时追高平均倒亏，别追`);
      }
    }

    // ---- A 级：资金费率拥挤（外部情绪证据，|z|≥0.7 五日逆向命中 ETH70.7%）----
    if (funding && funding.tilt !== 'osc') {
      const crowded = funding.tilt === 'bear' ? '杠杆多头拥挤' : '杠杆空头拥挤';
      pros.push({
        vote: funding.tilt === 'bear' ? 'short' : 'long',
        weight: 1.6,
        text: `${crowded}（年化费率 ${funding.annualized.toFixed(2)}%）：拥挤盘出清易走反向，ETH历史逆向命中率71%`,
      });
    }

    // ---- B 级：合成器/九线喊多 = 阶段末端；BOLL 冲上轨 = 涨过头 ----
    const synth = calcPredictionSynth(klines);
    if (synth && synth.direction === 'up') {
      warns.push('多个指标同时喊多（预测合成器）——实测喊多后常是阶段高点，别跟单追高');
    }
    const ab9 = calcAB9Lines(klines);
    if (ab9 && ab9.direction === 'up' && ab9.strength !== '趋势破坏') {
      warns.push('九线测算显示上升波段已走一段——实测此时追高后续平均倒亏约6%');
    }
    if (bb) {
      supCand.push(bb.lower);
      resCand.push(bb.upper);
      if (price > bb.upper) {
        warns.push(`价格冲出布林上轨 ${pf(bb.upper)}，短线涨过头，历史倾向回落`);
      }
    }

    // ---- 结构位：价值区域（成交密集区）----
    const va = calcValueArea(klines, 80);
    if (va) {
      supCand.push(va.val);
      resCand.push(va.vah);
      if (va.poc <= price) supCand.push(va.poc);
      else resCand.push(va.poc);
    }

    // ---- ATR：波动，用来给止损留缓冲、算仓位 ----
    const atrArr = calcATRArray(klines, 14);
    const atr = atrArr[atrArr.length - 1];

    // 离现价最近的真实结构位
    const nearSupport = supCand.filter((p) => Number.isFinite(p) && p < price).sort((a, b) => b - a)[0] ?? null;
    const nearResist = resCand.filter((p) => Number.isFinite(p) && p > price).sort((a, b) => a - b)[0] ?? null;

    // ---- A 级加权投票 ----
    let longW = 0;
    let shortW = 0;
    for (const e of pros) {
      if (e.vote === 'long') longW += e.weight ?? 1;
      if (e.vote === 'short') shortW += e.weight ?? 1;
    }
    const totalW = longW + shortW;
    const longRatio = totalW ? longW / totalW : 0.5;
    const longN = pros.filter((e) => e.vote === 'long').length;
    const shortN = pros.filter((e) => e.vote === 'short').length;

    let action: Action = 'wait';
    if (totalW && longRatio > 0.6) action = warns.length >= 1 ? 'long-pullback' : 'long';
    else if (totalW && longRatio < 0.4) action = 'short';

    // ---- 操作计划：止损放在结构位外侧 0.5 个 ATR，避免被正常波动扫掉 ----
    const buf = atr && Number.isFinite(atr) ? atr * 0.5 : 0;
    let entry: number | null = price;
    let stop: number | null = null;
    let target: number | null = null;
    if (action === 'long') {
      stop = nearSupport != null ? nearSupport - buf : null;
      target = nearResist;
    } else if (action === 'long-pullback') {
      entry = nearSupport;                       // 等回踩到支撑附近再买
      stop = nearSupport != null ? nearSupport - buf : null;
      target = nearResist;
    } else if (action === 'short') {
      stop = nearResist != null ? nearResist + buf : null;
      target = nearSupport;
    }

    const stopDistPct = entry != null && stop != null ? Math.abs(entry - stop) / entry * 100 : null;
    const rr = entry != null && stop != null && target != null && Math.abs(entry - stop) > 0
      ? Math.abs(target - entry) / Math.abs(entry - stop)
      : null;
    const posPct = stopDistPct && stopDistPct > 0
      ? Math.min(100, Math.max(2, Math.round((RISK_PER_TRADE / stopDistPct) * 100)))
      : null;

    // ---- 一句话结论 ----
    let headline: string;
    if (action === 'long') {
      headline = `${longN} 项实证信号看多，现价附近可轻仓试多，回踩支撑不破可加仓`;
    } else if (action === 'long-pullback') {
      headline = `大方向偏多（${longN} 项看多），但短线有 ${warns.length} 项见顶风险，别追，等回踩支撑再买`;
    } else if (action === 'short') {
      headline = `${shortN} 项实证信号看空，反弹到阻力附近可轻仓试空`;
    } else if (totalW) {
      headline = '多空实证信号打架，方向不明，观望为主，等信号一边倒';
    } else {
      headline = '当前没有实证有效的信号，空仓等待，别凭感觉进场';
    }

    return {
      price, pf, action, longRatio, longN, shortN, headline,
      pros, warns, notes, entry, stop, target, rr, stopDistPct, posPct,
      nearSupport, nearResist, atr,
      cloudBottom, cloudTop,
    };
  }, [klines, refreshKey, precision, funding]);

  if (!model) {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-dark-800/30 px-4 py-3 text-xs text-dark-400">
        交易决策 · 等待K线数据…
      </div>
    );
  }

  const meta = ACTION_META[model.action];
  const pctLong = Math.round(model.longRatio * 100);

  const PlanCell = ({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'long' | 'short' | 'mute' }) => {
    const valColor = tone === 'long' ? 'text-emerald-300' : tone === 'short' ? 'text-red-300' : 'text-slate-200';
    return (
      <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-2.5 py-2 flex flex-col gap-0.5">
        <span className="text-[10px] text-dark-400">{label}</span>
        <span className={`text-[13px] font-mono font-semibold tabular-nums leading-tight ${valColor}`}>{value}</span>
        {sub ? <span className="text-[10px] text-dark-400 leading-tight">{sub}</span> : null}
      </div>
    );
  };

  const isLong = model.action === 'long' || model.action === 'long-pullback';

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-dark-800/30 overflow-hidden flex flex-col">
      {/* 头部：结论 */}
      <div className="px-3 pt-2.5 pb-2 border-b border-dark-700/40 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-slate-200">交易决策</span>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${meta.chip}`}>{meta.label}</span>
          {model.pros.length > 0 && (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="flex h-1.5 w-20 rounded-full overflow-hidden bg-dark-700/60">
                <span className="bg-emerald-500" style={{ width: `${pctLong}%` }} />
                <span className="bg-red-500" style={{ width: `${100 - pctLong}%` }} />
              </span>
              <span className="text-[10px] text-dark-400 font-mono tabular-nums">{model.longN}多 / {model.shortN}空</span>
            </span>
          )}
        </div>
        <p className={`text-[11px] leading-snug ${meta.text}`}>{model.headline}</p>
      </div>

      {/* 操作计划 */}
      {model.action === 'wait' ? (
        <div className="px-3 py-2.5 grid grid-cols-2 gap-2">
          <PlanCell label="转多触发" value={model.nearResist != null ? model.pf(model.nearResist) : '--'} sub="站稳此阻力上方再考虑做多" tone="long" />
          <PlanCell label="转空触发" value={model.nearSupport != null ? model.pf(model.nearSupport) : '--'} sub="跌破此支撑下方再考虑做空" tone="short" />
        </div>
      ) : (
        <div className="px-3 py-2.5 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <PlanCell
              label={model.action === 'long-pullback' ? '入场（等回踩）' : '入场参考'}
              value={model.pf(model.entry)}
              sub={model.action === 'long-pullback' ? `现价 ${model.pf(model.price)}，挂支撑附近` : '现价附近分批'}
              tone={isLong ? 'long' : 'short'}
            />
            <PlanCell label="止损（跌破/站上就走）" value={model.pf(model.stop)} sub={model.stopDistPct != null ? `距入场 ${model.stopDistPct.toFixed(2)}%` : '结构位不足，手动止损'} tone="mute" />
            <PlanCell label="第一目标" value={model.pf(model.target)} sub="到位先减半仓" tone={isLong ? 'long' : 'short'} />
            <PlanCell
              label="盈亏比"
              value={model.rr != null ? `1 : ${model.rr.toFixed(2)}` : '--'}
              sub={model.rr != null ? (model.rr >= 1.5 ? '划算，可做' : '不到1.5，不划算') : ''}
              tone="mute"
            />
          </div>
          <div className="rounded-lg border border-dark-700/50 bg-dark-900/40 px-2.5 py-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] text-dark-400">建议仓位（按单笔最多亏本金 {RISK_PER_TRADE}% 算）</span>
            <span className={`text-[12px] font-mono font-bold tabular-nums ${model.posPct != null && model.stopDistPct != null && model.stopDistPct >= 8 ? 'text-amber-300' : 'text-slate-200'}`}>
              {model.posPct != null
                ? `约 ${model.posPct}% 本金`
                : '--'}
            </span>
          </div>
          {model.posPct != null && model.stopDistPct != null && model.stopDistPct >= 8 && (
            <p className="text-[10px] text-amber-400/90 leading-tight -mt-1">止损距离过宽（{model.stopDistPct.toFixed(1)}%），说明位置不好，建议放弃或再减半仓</p>
          )}
        </div>
      )}

      {/* 关键价位 */}
      <div className="mx-3 mb-2.5 rounded-lg bg-dark-900/40 border border-dark-700/50 px-2.5 py-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums">
        <span className="text-emerald-300">最近支撑 {model.pf(model.nearSupport)}</span>
        <span className="text-dark-500 text-[10px]">现价 {model.pf(model.price)}</span>
        <span className="text-red-300">最近阻力 {model.pf(model.nearResist)}</span>
      </div>

      {/* 实证依据 */}
      {model.pros.length > 0 && (
        <div className="px-3 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-emerald-400/80 pb-1">为什么这么判 · 回测实证</div>
          <ul className="flex flex-col gap-1">
            {model.pros.map((e, i) => (
              <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-dark-300">
                <span className={e.vote === 'long' ? 'text-emerald-400 shrink-0' : 'text-red-400 shrink-0'}>{e.vote === 'long' ? '看多' : '看空'}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 末端风险 */}
      {model.warns.length > 0 && (
        <div className="px-3 pb-2.5">
          <div className="text-[10px] uppercase tracking-wider text-amber-400/90 pb-1">风险提醒 · 这些情况别追</div>
          <ul className="flex flex-col gap-1">
            {model.warns.map((w, i) => (
              <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-amber-200/80">
                <span className="text-amber-400 shrink-0">⚠</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 结构参考（不投票） */}
      {model.notes.length > 0 && (
        <div className="px-3 pb-2.5">
          <ul className="flex flex-col gap-1">
            {model.notes.map((t, i) => (
              <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-dark-400">
                <span className="text-dark-500 shrink-0">·</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-auto px-3 py-1.5 border-t border-dark-700/40 text-[9.5px] text-dark-500 leading-tight">
        依据 BTC/ETH 4h+1d 共3920根K线回测，只统计跨行情稳定的信号 · 概率不是必然，严格止损
      </div>
    </div>
  );
}
